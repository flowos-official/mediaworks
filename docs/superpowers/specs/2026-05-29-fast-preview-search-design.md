# Fast Preview Search — surface the searched product in the streaming preview (~1s, flag-independent)

- **Date**: 2026-05-29
- **Status**: Design (approved, pre-implementation)
- **Area**: MD strategy expansion (`/[locale]/analytics/strategy/expansion`) streaming discovery preview
- **Related**: `docs/superpowers/specs/2026-05-28-search-granularity-tiers-design.md` (Phase 0.5 SearchIntent)

## Problem

On `/analytics/strategy/expansion` the operator types a free-text goal (e.g. `テレ東マートで売れる包丁を探して` / Korean `테레동 마트에서 팔리는 칼을 찾아라`) and submits. The UI shows discovery cards in two stages:

1. **Immediate preview** — `runPreliminaryDiscoveryStep` (`lib/workflows/md-strategy.workflow.ts:343`) → `runPreliminaryDiscovery` (`lib/strategy/preliminary-discovery.ts`). **Pool-only** (`discovered_products`), no Gemini, no fresh Rakuten/Brave. Emits a `preliminary_discovery` complete event; the client renders these cards within ~1s (`MDStrategyPanel.tsx:546-553`, `:669-673`).
2. **Final/saved result** — `runDiscoveryStep` (`workflow.ts:417`) → `discoverNewProducts`. Pool + fresh Rakuten/Brave + Gemini curation. Replaces the preview cards and is saved to `md_strategies`; this is what the history shows.

The immediate preview does **not** reflect the searched product. Empirically reproduced against the live pool for the knife goal (flag off, current production): the preview returns the generic top-of-pool — **0 of 15 cards are knives** (レンジクッカー, ヒーター, 振動マシン, 温熱治療器, EMSブーツ, 防災ラジオ, 毛玉取り, シューズ, 骨盤ベルト, マットレス, 漂白剤). With `intent` removed the result is byte-identical, i.e. the goal currently has **zero filtering effect on the preview**.

Root chain in `lib/strategy/pool-query.ts::applyFilters`:
- Flag off → `projectParsedGoalToIntent` forces `intent_tier="broad"`, `specific_keyword=null` → the Tier-4 hard substring match never runs.
- The only filter that runs (R4.5 fuzzy keyword) uses keywords polluted with generic theme words (`時短 / 多機能 / 切れ味 / お手入れ簡単 / ギフト / 新生活`) that match almost any home-shopping product.
- R4.5 is fail-open: needs ≥5 matches or it reverts to the pre-intent pool, so the knife-narrow result (~1 row) is discarded and the raw pool top is returned.

The preview is fast precisely because it is pool-only. The pool currently holds very few knives (the live reproduction found ~1 knife in the top-fit fetch window), so even fixing the filter or flipping the flag yields a sparse preview. To show the actual searched product fast, a lightweight fresh search is required.

## Goal

When the operator's goal names a concrete product/category, the streaming preview surfaces **real instances of that product within ~1s**, replacing the generic pool preview — **without depending on the `PHASE_0_5_SEARCH_INTENT_ENABLED` flag**.

## Non-goals

- Changing the final/saved curated discovery (`discoverNewProducts`) or the Gemini curation prompt.
- Flipping or removing `PHASE_0_5_SEARCH_INTENT_ENABLED` (complementary but separate — see Out of Scope).
- The non-streaming rediscover path (`/api/analytics/md-strategy/[id]/rediscover`), which has no preliminary preview.
- Persisting preview results to `discovered_products` (preview is display-only; the final step already persists).
- Brave / channel `site:` search in the preview (Rakuten alone is fast and sufficient for v1).

## Chosen approach (Option A): dedicated fast-preview workflow step

Add a new workflow step `runFastPreviewSearchStep`, run immediately after `runPreliminaryDiscoveryStep`. It performs a single Rakuten keyword search and emits a **second `preliminary_discovery` complete event** carrying the fresh results.

Rejected alternatives:
- **B — augment `runPreliminaryDiscovery`**: breaks its documented "pool-only, no fresh search" contract (`preliminary-discovery.ts:1-10`) and couples a pure pool reader to network I/O.
- **C — client-side parallel API call**: needs a new authenticated endpoint and duplicates keyword derivation; larger surface.

The client already handles `preliminary_discovery` complete by replacing `preliminaryProducts` (`MDStrategyPanel.tsx:546-553`). A second emit replaces the pool preview with **zero client logic change** (one optional cosmetic label tweak).

## Key design decision: flag-independent preview keyword

```ts
previewKeyword =
  intent?.specific_keyword?.normalized   // flag ON  → "包丁"
  ?? intent?.category_hints?.[0]          // flag OFF → "包丁" (legacy goal prompt populates category_hints)
  ?? null;                                // no signal → skip; pool preview stands
```

This is the crux: `buildGoalPromptLegacy` (`md-strategy.ts:1970-2020`) already populates `category_hints` with the concrete product term even when the flag is off (live repro: `category_hints=["包丁","三徳包丁",...]`). Using `category_hints[0]` as the fallback makes the fast preview work in both flag states, so this change does not require enabling Phase 0.5.

## Components

### 1. `lib/strategy/fast-preview-search.ts` (new)

```
runFastPreviewSearch(input: {
  intent?: DiscoverIntent;
  priceRange?: string;
  excludeProductIds?: string[];     // seed ids
}): Promise<DiscoveredProduct[]>
```

- Derive `previewKeyword` per the rule above. If `null` → return `[]` (skip).
- Run **one** `rakutenItemSearch(previewKeyword, "-reviewCount", 12)`; if empty, fall back to `rakutenRankingSearch(previewKeyword)`. No Brave.
- Map items → `DiscoveredProduct[]` with `pool_source: "fresh_search"` and a `reason` like `"検索結果（暫定） — 戦略分析完了後に精緻化されます"`. **Not persisted to any DB.**
- Apply the existing price-range parse/filter (reuse `parsePriceRangeLocal` pattern from `preliminary-discovery.ts`).
- De-dupe by `source_url`; drop items resembling existing TV products is **not** needed here (preview only).
- Wrap in try/catch; any error → return `[]`.
- Must be `tsx`-importable (no `import "server-only"`; rely on existing Rakuten client). Mirror the import discipline noted in CLAUDE.md.

### 2. Pool-knife merge (included in v1)

When the pool preview already contains rows matching `previewKeyword` (e.g. a TV-channel `スーパーストーンバリア包丁`), those are higher-signal than generic Rakuten hits. The fast-preview step merges them: pool matches first, then Rakuten fresh, de-duped by URL, capped at the preview target (15). Implemented inline in the workflow step using the already-fetched `preliminary` array (no extra query) — a small `mergePreviewByKeyword(poolItems, freshItems, previewKeyword)` helper in `lib/strategy/fast-preview-search.ts`.

### 3. `lib/workflows/md-strategy.workflow.ts` — new step + emit

- Add `runFastPreviewSearchStep(input, preliminary, preRunParsedGoal)` after the preliminary emit (`workflow.ts:343-350`).
- `intent = preRunParsedGoal ? projectParsedGoalToIntent(preRunParsedGoal) : undefined` (same projection already used at `:171`).
- `const fresh = await runFastPreviewSearch({ intent, priceRange: input.priceRange, excludeProductIds: seedIds })`.
- Merge with pool-knife matches (component 2). If the merged set is non-empty, emit a second `preliminary_discovery` complete event: `{ skill: "preliminary_discovery", status: "complete", index: -1, total: 7, data: { products: merged } }`.
- `runFastPreviewSearchStep.maxRetries = 0`; non-fatal try/catch — on any failure the first (pool) preview stands. No new `ProgressEvent.skill` value needed.

### 4. `components/analytics/MDStrategyPanel.tsx` — no logic change

The existing handler replaces `preliminaryProducts` on the second event. Optional: relabel the hero pill to "検索結果（暫定）" when items carry `pool_source: "fresh_search"`. v1 may skip this.

## Data flow

```
fetchContext
  → preRunGoalAnalysis (ParsedGoal; flag-independent category_hints)
  → preliminary (pool)            emit#1  ~0.x s   (instant; may be empty/sparse)
  → ★ fastPreviewSearch (Rakuten) emit#2  ~1 s     (real searched product; replaces #1)   ← NEW
  → skill loop … → final discoverNewProducts  emit#3 (full curation; replaces) → save md_strategies
```

## Latency & failure

- One Rakuten `itemSearch` (~0.5–1s; within the 1 req/sec limit since no other Rakuten call is in flight at this point). Adds ~1s before the skill loop starts — negligible against the 30–60s skill phase. (If even that is undesirable, the step can be fired without `await` before the loop; v1 awaits for simplicity.)
- All failures are swallowed → `[]` → pool preview remains. Step never aborts the pipeline.

## Edge cases

- **No `userGoal` / no signal**: `previewKeyword=null` → skip; behavior unchanged (pool preview only).
- **Broad/seasonal goal** (e.g. `冬に売れる商品`): `category_hints[0]` ≈ `暖房家電` → preview shows seasonally relevant products. Acceptable / beneficial.
- **Rakuten empty for the keyword**: ranking-API fallback, then `[]`.
- **Pool already had the product**: merged on top (component 2).
- **Korean channel mention** (`테레동 마트`): irrelevant here — the preview keys off the product term (`칼`→`包丁`, which Gemini normalizes reliably, confidence 1.0 in repro), not the channel.

## Testing

- `scripts/test-fast-preview.ts` (smoke, live Rakuten via `tsx --env-file=.env.local`):
  1. `PHASE_0_5_SEARCH_INTENT_ENABLED="false"`; `pg = await runGoalAnalysis("テレ東マートで売れる包丁を探して")`; `intent = projectParsedGoalToIntent(pg)`; assert `previewKeyword` resolves to `包丁` via `category_hints[0]`.
  2. `runFastPreviewSearch({ intent })` → assert ≥1 result and that names are knives (`包丁/ナイフ/三徳/牛刀/ペティ`).
  3. Repeat with the flag `"true"` → assert `previewKeyword` from `specific_keyword.normalized` and knife results.
  4. No-goal case → `[]`.
- Add `test:fast-preview` to `package.json` scripts.

## Out of scope (recommended separately)

- **Enable `PHASE_0_5_SEARCH_INTENT_ENABLED=true`** in Vercel Production (per `2026-05-28` spec §9-3 staged rollout). Independent of this design, it improves the **final/saved** result precision: Tier-4 hard pool match, `txd` channel scope, and the TIER-4 "exact match" Gemini curation directive. With the flag on, the *pool* half of the preview also hard-matches (component 2 surfaces more pool knives). Verify current value with `vercel env ls production` (the `.vercel/.env.production.local` snapshot is stale, dated before the 2026-05-28 merge).
- The pre-existing bug where the final `discoverNewProducts` (`md-strategy.ts:623-631`) does not forward `intentTier/specificKeyword/specificAliases` to `queryDiscoveredPool` (so the final path's pool contribution is not knife-hard-matched). Tracked separately; the final result is currently rescued by fresh search + goal text in the curation prompt.
