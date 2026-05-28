# Search Granularity Tiers — Design

**Date:** 2026-05-28
**Status:** Draft (awaiting user review before implementation plan)
**Owner:** TBD
**Pipeline affected:** MD Strategy + Live Commerce (intent struct shared)

## 1. Problem

Free-text MD strategy search ("knife (칼)" / "テレ東マートで売れる包丁") currently dilutes results when the user specifies a narrow product type. In a recent operator session, a search for "包丁" returned 17 candidates of which 16 were not knives. Three root causes:

1. **Pool fail-open** — `lib/strategy/pool-query.ts:102-109` drops the intent filter entirely when fewer than 5 rows match, returning the broad pre-intent pool.
2. **Mixed search keywords** — `lib/md-strategy.ts:687-692` concatenates intent queries with broad TV category names, so Rakuten/Brave fetches are dominated by non-target categories.
3. **Gemini diversity instruction** — `lib/md-strategy.ts:1122` literally tells the curation LLM "カテゴリが偏らないように" regardless of how narrow the user's intent is.

The system has no concept of "how narrow is this query" — every free-text input is treated the same.

## 2. Goal

Make the existing free-text input understand four search granularity tiers:

| Tier | Example | Today | Target |
|---|---|---|---|
| 1 broad | "잘 팔리는 상품" | works | works (unchanged) |
| 2 seasonal | "겨울에 잘 팔리는" | works | works (unchanged) |
| 3 genre | "피트니스 상품" | partially works (relies on UI dropdown) | works from free text |
| 4 specific keyword | "잘 팔리는 칼" | broken (17 vs 1) | knives only |

Optionally scoped by a TV channel mention ("テレ東マートで") whose **interpretation is a taste profile**: not "items that channel currently sells" but "items that would likely sell on that channel," derived from broadcast calendar data.

## 3. Non-Goals (v1)

- New UI fields. Input stays free-text + 8-category dropdown + targetMarket + priceRange (per user direction 2026-05-28).
- Multiple specific keywords in one query (e.g. "칼이나 도마") — v1 accepts a single primary keyword; secondary terms fall through to `category_hints`.
- User override of the classification result. The classification chip is read-only in v1.
- Automatic learning of channel alias spellings. v1 uses a static alias table.

## 4. Architecture

### 4-1. Pipeline placement

The new search-intent classification fields are added to the existing **`goal_analysis` skill's JSON output** (`runGoalAnalysis` in `lib/md-strategy.ts:1845`). No new Gemini call. No new skill. The fields travel with `parsedGoal` into every downstream consumer.

```
[fetchContextStep]
       │
       ▼
[pre-run runGoalAnalysis] ← NEW: runs before preliminary discovery so intent is available
       │   produces: parsedGoal (extended schema), stored on ctx.parsedGoal
       ▼
[runPreliminaryDiscoveryStep]   ← receives intentKeywords + tier + specific_keyword
       │   user sees first results that already respect the tier
       ▼
[skill loop: goal_analysis (short-circuit), product_selection, channel_strategy, ...]
       │
       ▼
[runDiscoveryStep]              ← tier-branched fresh search + curation
       │
       ▼
[saveStrategyStep] → results UI (with read-only intent chip)
```

Cache reuse requires a code change in `lib/md-strategy.ts:2601-2602` (`runMDSkill`). Today that function **unconditionally** calls `runGoalAnalysis(context.userGoal)` whenever the loop hits `goal_analysis`, ignoring any prior result on `context`. The change: when `context.parsedGoal` is already populated (set by the new pre-run step), return it instead of re-invoking Gemini. This is the only way to avoid double-billing + classification drift between the pre-run and the skill-loop run.

The pre-run also feeds three other entry points that bypass the workflow entirely — see §6 touchpoints #14-16.

### 4-2. SearchIntent schema (extension of ParsedGoal)

```ts
interface ParsedGoal {
  // existing fields (unchanged)
  primary_objective: string;
  target_channels: string[];
  target_revenue?: string;
  target_audience?: string;
  budget_constraint?: string;
  timeline?: string;
  seasonal_keywords: string[];
  theme_keywords: string[];
  category_hints: string[];
  excluded_themes: string[];

  // NEW
  intent_tier: "broad" | "seasonal" | "genre" | "specific_keyword";
  channel_scope: Array<{
    channel_slug: string;     // normalized to tv-channels.ts registry
    raw_mention: string;
    confidence: number;       // 0.0~1.0
  }>;
  specific_keyword: {
    raw: string;              // user's term (any language)
    normalized: string;       // canonical Japanese form for matching ("包丁")
    aliases: string[];        // Gemini-supplied synonyms ("ナイフ","knife","キッチンナイフ")
    confidence: number;       // hard-filter threshold default 0.7
  } | null;
}
```

`DiscoverIntent` (in `lib/strategy/discover-intent.ts:15`) gets the same three new fields. `normalizeDiscoverIntent` extended to accept them.

**Why aliases live on the schema, not as a separate alias table**: A static alias JSON would freeze synonym coverage and create a maintenance burden. The Gemini classifier already understands product synonyms; surfacing them in the same call costs no extra round-trip. Downstream substring match becomes `(normalized + aliases).some(a => name.includes(a))`. Aliases capped at 6 in the prompt to keep the match cheap.

**Deterministic alias guard (post-parse, not prompt-only)**: Gemini might still emit an over-broad alias (e.g. "包丁" → "キッチン用品") despite the prompt instruction. After JSON parse, `runGoalAnalysis` runs a filter that drops any alias matching:
- An entry in the same response's `category_hints` (those are intentionally broad — never an alias)
- A known broad-term blocklist in `lib/strategy/alias-blocklist.ts` (≈30 entries: キッチン用品, 家電, 服, 食品, 美容, …)
- Length < 2 characters

Dropped aliases are logged but don't fail the request. This guard is independent of Gemini's compliance with the prompt — it's deterministic and testable. Codex review specifically flagged that prompt-only restrictions are not sufficient.

### 4-3. Classification rules (added to runGoalAnalysis prompt)

```
intent_tier:
- "specific_keyword": single narrow product type named (包丁, ホットカーペット, EMS, ...)
- "genre": broad product genre only (フィットネス, 美容家電, ...)
- "seasonal": season/event only (冬, お歳暮, クリスマス, ...)
- "broad": none of the above

Multi-signal cases pick the narrowest tier and still extract the other axes.
Example: "テレ東マートで冬に売れる包丁" → tier=specific_keyword,
  channel_scope+seasonal_keywords also populated.

channel_scope.confidence:
- exact match in tv-channels.ts registry → 1.0
- alias-table match (テレビ東京マート → txd) → 0.8
- ambiguous mention → < 0.5 → ignored at runtime

specific_keyword.confidence:
- single, narrow product noun → ≥ 0.9
- broad category mistaken as specific → < 0.7 → hard-filter NOT applied (treated as tier=genre)

specific_keyword.aliases:
- supply up to 6 synonyms for the canonical form
- include katakana / hiragana / English / 中国漢字 variants the user might mean
- exclude broader category words (e.g. 包丁 → ["ナイフ","knife","キッチンナイフ","三徳包丁","菜切り包丁","ペティナイフ"] — NOT "キッチン用品")
```

EXAMPLES block adds three cases (verbatim in prompt):

```
- 「テレ東マートで売れる包丁」 →
  intent_tier: "specific_keyword"
  channel_scope: [{channel_slug:"txd", raw_mention:"テレ東マート", confidence:0.9}]
  specific_keyword: {raw:"包丁", normalized:"包丁",
                     aliases:["ナイフ","knife","キッチンナイフ","三徳包丁","菜切り","ペティナイフ"],
                     confidence:0.95}
  category_hints: ["キッチン用品", "包丁"]

- 「QVCで冬に売れる暖房家電」 →
  intent_tier: "genre"
  channel_scope: [{channel_slug:"qvc", raw_mention:"QVC", confidence:1.0}]
  specific_keyword: null
  seasonal_keywords: ["冬"]
  category_hints: ["暖房家電","ヒーター","電気ストーブ"]

- 「冬に売れる商品」 →
  intent_tier: "seasonal"
  channel_scope: []
  specific_keyword: null
  seasonal_keywords: ["冬"]
```

### 4-4. Tier-branched behavior matrix

| Stage | broad | seasonal | genre | specific_keyword |
|---|---|---|---|---|
| Pool category filter (R4) | none | none | UI category match | UI category match |
| Pool intent filter (R4.5) | OFF | seasonal+theme keywords | category_hints | **(normalized + aliases), fail-open OFF** |
| Fresh search primary keyword | broad TV category | season × theme | category_hints | **specific_keyword.normalized alone (aliases as 2nd query if pool < 5)** |
| TV broad-category keyword weight | 100% | 100% | 50% | **0% (suppressed)** |
| Broadened fallback at empty pool (`lib/md-strategy.ts:931-959`) | runs | runs | runs | **suppressed — return what we have, don't dilute** |
| Name-level post-filter | none | none | none | **at least one of (normalized, aliases) substring required** |
| Channel taste boost | applied if scope set | same | same | same |
| Gemini diversity instruction | keep | keep | keep | **replace with "match user's exact item"** |
| Excluded themes | applied | applied | applied | applied |

## 5. Channel Taste Profile

When `channel_scope` is populated, candidates are boosted toward the channel's category mix × operator's curated fit score.

### 5-1. Data sources (tiered)

| Tier | Channels | Source | Notes |
|---|---|---|---|
| 1 | qvc, shopch | `broadcasts.category` | populated daily; ignore NULL rows |
| 2 | japanet, ntv, tbs, dinos, ropping, senobura, rakurakum, ichiban | `historical_broadcasts.category` | populated by `lib/historical-crawl/category-backfill.ts`; if NULL > 90% for a channel, fall through to Tier 3 |
| 3 | kachimo, kaidoki, kantv, others not in broadcasts/historical | `discovered_products` where `tv_channel_source LIKE '%<slug>%'`, aggregate `category` distribution client-side | weak signal; half boost strength |
| 4 | unknown slug | none | scope ignored, chip shows "(데이터 부족)" |

### 5-2. New helper module

`lib/discovery/channel-taste.ts` (new file):

```ts
interface ChannelTasteProfile {
  channel_slug: string;
  source_tier: 1 | 2 | 3 | 4;
  category_weights: Map<string, {
    raw_share: number;          // 0~1
    fit_score: number | null;   // from competitor_fit_analyses, null if samples < 3
    final_weight: number;       // raw_share × (fit_score/50, default 1.0)
  }>;
  sample_size: number;
  reasoning: string;
}

export async function loadChannelTasteProfile(
  channelSlug: string,
  lookbackDays?: number,
): Promise<ChannelTasteProfile>;

export async function loadChannelTasteProfiles(
  channelSlugs: string[],
  lookbackDays?: number,
): Promise<Map<string, ChannelTasteProfile>>;
```

### 5-3. competitor_fit_analyses scoping

**DB side (already supports this):** `competitor_fit_analyses` already has `channel text NOT NULL` (`supabase/migrations/2026-05-18_competitor_fit_analyses.sql:13`). No migration needed.

**Code side (must change):** three signatures need extending — two internal loaders and one public entrypoint. All ungated today:

- `lib/discovery/competitor-trend-boost.ts:49 loadHotCompetitorCategories()` — queries `broadcasts` ungated
- `lib/discovery/competitor-trend-boost.ts:92 loadCategoryFitWeights()` — queries `competitor_fit_analyses` ungated
- `lib/discovery/competitor-trend-boost.ts:168 applyCompetitorTrendBoost(candidates)` — the public entrypoint consumed by `app/api/cron/daily-discovery-home/route.ts:141` and the strategy discovery path. **Codex review caught this — channel-scope must thread through this signature too.**

All three are extended to accept `channelScope?: string[]`. When set, each loader adds `WHERE channel = ANY($1)` to its query and `applyCompetitorTrendBoost` forwards the param down. When empty/undefined, behavior is unchanged.

## 6. Touchpoints

**20 files modified + 5 new files** (revised after three Codex review rounds). Round 1 added: 3 additional caller sites, cache-short-circuit, fallback-suppression, LC prompt/parser/schema chain. Round 2 added: prompt-level flag gating, deterministic alias guard, `applyCompetitorTrendBoost` signature, `alias-blocklist.ts` new file. Round 3 added: `feature-flags.ts` new file to break the `intent-projection ↔ md-strategy` import cycle, defining-file exemption clarified in §9-1.

### 6-1. Core (MD pipeline + shared types)

| # | File / location | Change |
|---|---|---|
| 1 | `lib/strategy/discover-intent.ts` | Add 3 new fields to `DiscoverIntent`. Extend `normalizeDiscoverIntent`. Extend `deriveIntentKeywords` to include `specific_keyword.normalized + aliases` |
| 2 | `lib/md-strategy.ts:259 ParsedGoal` | Add 3 new fields (mirrors DiscoverIntent) |
| 3 | `lib/md-strategy.ts:1845 runGoalAnalysis` | Extend prompt with classification rules + examples (incl. alias extraction). Parse 3 new fields from JSON response |
| 4 | `lib/registry/skills/goal_analysis/v1/schema.ts` | Sync stale schema to runtime (currently missing the 4 existing intent arrays). Add new 3 fields. Use Zod `.optional()` + ensure schema is additive-safe (no `.strict()`) |
| 5 | `lib/workflows/md-strategy.workflow.ts:312` | Pre-run via `analyzeGoalToIntent` (chokepoint helper — see §9-1 caller #1) once before `runPreliminaryDiscoveryStep`. Store result on `ctx.parsedGoal` |
| 6 | `lib/md-strategy.ts:2601-2602 runMDSkill` | **Short-circuit**: when `context.parsedGoal` is already set, return it without calling `runGoalAnalysis` again. Today line 2602 unconditionally re-invokes Gemini (would cause double-billing + classification drift). |
| 7 | `lib/strategy/preliminary-discovery.ts:65` | Add `intentKeywords?`, `specificKeyword?`, `specificAliases?`, `intentTier?` to `PreliminaryDiscoveryInput`. Pass to `queryDiscoveredPool` |
| 8 | `lib/strategy/pool-query.ts:71 applyFilters` | When `intent_tier === 'specific_keyword'`: turn off R4.5 fail-open. Substring match accepts ANY of `(normalized, ...aliases)` against `name + category` |
| 9 | `lib/strategy/discover-intent.ts:139 buildIntentSearchQueries` | tier 4 → `[specific_keyword.normalized]` (aliases as 2nd query only if first returns empty). tier 3 → category_hints. tier 2 → existing season × theme |
| 10 | `lib/strategy/discover-intent.ts:177 formatIntentPromptSection` | tier 4 → append "ユーザーは特定品目を指定 — 該当商品のみ選定、カテゴリ多様化禁止" |
| 11 | `lib/md-strategy.ts:1122` (curation prompt) | "カテゴリが偏らないように" emitted only when `intent_tier !== 'specific_keyword'`. Tier 4 replaces with "ユーザー指定品目に一致する商品を最優先" |
| 12 | `lib/md-strategy.ts:931-959 discoverNewProducts` (broadened fallback) | **Suppress** the `["人気商品","売れ筋","おすすめ"]` empty-pool fallback when `intent_tier === 'specific_keyword'`. Returning fewer-but-correct results > diluting with broad keywords. Add tv broad-category keyword weight=0 in same branch (currently mixed at line 687-691). |

### 6-2. Channel taste + competitor scoring

| # | File / location | Change |
|---|---|---|
| 13 | `lib/discovery/competitor-trend-boost.ts:49, :92, :168` | THREE signatures extended with `channelScope?: string[]`: `loadHotCompetitorCategories` (:49), `loadCategoryFitWeights` (:92), `applyCompetitorTrendBoost` (:168 public entrypoint). All three currently take no channel param. See §5-3 |

### 6-3. Live Commerce pipeline (mirror — Codex found these were under-listed)

| # | File / location | Change |
|---|---|---|
| 14 | `lib/workflows/live-commerce.workflow.ts:54-61` | LC intent projection extended to forward the 3 new fields (otherwise silently dropped at runtime) |
| 15 | `lib/live-commerce-strategy.ts:222-228 ParsedGoal mirror` | LC `ParsedGoal` mirror updated to match MD shape |
| 16 | `lib/live-commerce-strategy.ts:487 LC goal-analysis prompt` + `:514 parser` + `:529 schema` | LC owns its own goal-analysis prompt/parser/schema. Extending only the MD prompt leaves LC blind. The 3 new fields must be added to the LC prompt's JSON schema, examples, and the parser's normalization. |

### 6-4. Direct API call sites (Codex found these — feature flag would have leaked without them)

These call `runGoalAnalysis` outside the workflow. The 3 new fields must be threaded through here too, and the feature flag (§9) must gate them.

| # | File / location | Change |
|---|---|---|
| 17 | `app/api/analytics/discovery/route.ts:108-120` | Replace inline intent projection (currently only forwards 4 existing arrays) with a shared helper that also forwards `intent_tier`, `channel_scope[]`, `specific_keyword` |
| 18 | `app/api/analytics/md-strategy/[id]/rediscover/route.ts:102-115` | Same fix — currently only forwards 4 arrays |
| 19 | `app/api/analytics/live-commerce/[id]/rediscover/route.ts` (analogous block) | Same fix |

### 6-5. New files

| Path | Purpose |
|---|---|
| `lib/strategy/feature-flags.ts` | Dependency-free `isPhase05Enabled()` reader. Separated from `intent-projection.ts` to avoid circular import with `md-strategy.ts` (which needs the flag for prompt-level gating per §9-3 while `intent-projection.ts` needs to import `runGoalAnalysis` from `md-strategy.ts`) |
| `lib/discovery/channel-taste.ts` | `loadChannelTasteProfile`, `loadChannelTasteProfiles` (Section 5) |
| `lib/strategy/channel-aliases.ts` | Maps free-text channel mentions ("テレビ東京マート") to registry slugs ("txd"). Used by `runGoalAnalysis` to normalize `channel_scope.channel_slug`. Distinct from `specific_keyword.aliases` (which is per-query, Gemini-supplied) |
| `lib/strategy/intent-projection.ts` | Single helper consumed by the 3 API routes (#17-19) AND used by both workflow and LC workflow (#5, #14). Defines `projectParsedGoalToIntent(parsedGoal)` and `analyzeGoalToIntent(userGoal)`. Imports flag reader from `feature-flags.ts`. The 2 defining files (`md-strategy.ts`, `live-commerce-strategy.ts`) may call their own `runGoalAnalysis`/`runLCGoalAnalysis` internally without routing through the helper — see §9-1 |
| `lib/strategy/alias-blocklist.ts` | ~30 broad Japanese category terms that must never appear in `specific_keyword.aliases` (e.g. キッチン用品, 家電, 服, 食品, 美容). Consumed by the deterministic alias guard in `runGoalAnalysis` (§4-2) |

### 6-6. UI

| # | File / location | Change |
|---|---|---|
| 20 | `components/analytics/MDStrategyPanel.tsx` | Add read-only intent chip block above results (see §7). Only visible when `parsedGoal.intent_tier !== 'broad'` or `channel_scope.length > 0` |

## 7. UI

`components/analytics/MDStrategyPanel.tsx` adds a read-only chip block above the results panel when `parsedGoal.intent_tier !== 'broad'`:

```
검색 의도: テレ東マート (チャネル適合度) × 包丁 (特定キーワード) × 冬 (季節)
```

When `source_tier = 3` or `4` for any channel scope, the chip annotates the weakness:

```
검색 의도: kachimo (データ不足 — 弱い信号) × 包丁
```

No interactive control in v1; the chip is purely informational so the user can spot a mis-classification.

## 8. Backward Compatibility

- All 3 new fields are optional. Consumers use `?? 'broad'` / `?? []` / `?? null` defaults.
- Existing saved strategies in `md_strategies.product_selection` JSONB deserialize with new fields undefined. Behavior matches pre-Phase-0.5 (tier=broad is the existing path).
- `lib/registry/skills/goal_analysis/v1/schema.ts` already drifted from runtime. The schema sync in touchpoint #4 brings both into alignment AND adds the new fields in a single PR. Recommendation: split into two commits — "sync stale goal_analysis schema" first, "add Phase 0.5 fields" second — so the sync is independently bisectable.
- `lib/registry/skills/goal_analysis/v1/schema.ts` MUST NOT use Zod `.strict()`. Verify before merging.

## 9. Feature Flag

```
PHASE_0_5_SEARCH_INTENT_ENABLED  (default: false)
```

### 9-1. Target chokepoint (to be created by this design)

**Flag READ in exactly one place**: `lib/strategy/feature-flags.ts` (new) exposes `isPhase05Enabled()`. `process.env.PHASE_0_5_SEARCH_INTENT_ENABLED` is referenced ONLY inside this module.

**Function CONSUMED by three modules** — all import `isPhase05Enabled()` from `feature-flags.ts`:
1. `lib/strategy/intent-projection.ts` (new — wraps `runGoalAnalysis` + projects to `DiscoverIntent`; gates flag-on vs flag-off projection)
2. `lib/md-strategy.ts` (existing — needs the flag for prompt-level gating per §9-3, swaps between legacy and extended Gemini prompts)
3. `lib/live-commerce-strategy.ts` (existing — same prompt-level gating for the LC variant)

This split avoids a circular import: if `intent-projection.ts` owned the flag reader and `md-strategy.ts` needed to read the flag, `md-strategy.ts` would have to import from `intent-projection.ts` which already imports `runGoalAnalysis` from `md-strategy.ts`. Putting the reader in its own dependency-free module breaks the cycle.

**Caller-side rule** — every caller that previously called `runGoalAnalysis` directly must route through `intent-projection.ts::analyzeGoalToIntent(userGoal)` instead. Today the direct call appears at six caller sites:

| # | File / location | Treatment |
|---|---|---|
| 1 | `lib/workflows/md-strategy.workflow.ts` (new pre-run step, touchpoint #5) | **must use `analyzeGoalToIntent`** |
| 2 | `lib/workflows/live-commerce.workflow.ts` (intent projection, touchpoint #14) | **must use `analyzeGoalToIntent` (or `analyzeLCGoalToIntent`)** |
| 3 | `lib/md-strategy.ts:2602` (inside `runMDSkill`, touchpoint #6) | **exempt** — defining file, may keep private `runGoalAnalysis` call as a fallback when `ctx.parsedGoal` is missing |
| 4 | `lib/live-commerce-strategy.ts` (LC equivalent of #3) | **exempt** — LC defining file, same reason |
| 5 | `app/api/analytics/discovery/route.ts:110` | **must reroute** (touchpoint #17) |
| 6 | `app/api/analytics/md-strategy/[id]/rediscover/route.ts:104` | **must reroute** (touchpoint #18) |
| 7 | `app/api/analytics/live-commerce/[id]/rediscover/route.ts:97` | **must reroute** (touchpoint #19) |

If a non-exempt caller is missed, the flag leaks for that path.

**Implementation guard**: a grep gate in CI/PR — `runGoalAnalysis(` and `runLCGoalAnalysis(` may only appear in `lib/strategy/intent-projection.ts`, `lib/md-strategy.ts`, and `lib/live-commerce-strategy.ts` (the helper + the two defining files). Any other usage fails the check.

### 9-2. Off behavior

When false, the projection helper returns the legacy 4-array `DiscoverIntent` and stamps `intent_tier='broad'`, `channel_scope=[]`, `specific_keyword=null`. Every consumer (pool-query, discover-intent helpers, curation prompt, competitor-trend-boost) falls through to tier-broad behavior.

**Behavioral equivalence — narrow claim**: For tier-broad inputs (no narrow keyword, no channel mention), the new pipeline branches are all bypassed and the resulting candidate set should match today's behavior. **Not byte-identical**: even when the flag is off, the Gemini prompt itself contains the extended schema instructions (tier classification rules, alias extraction, channel slug examples), which may marginally shift how Gemini fills the 4 existing arrays (seasonal_keywords, etc.). To guarantee byte-identical output, the prompt extension must also be flag-gated — see §9-3.

### 9-3. Prompt-level gating (defense against flag-off drift)

To prevent the extended classification prompt from perturbing existing field extraction when the feature is disabled, `runGoalAnalysis` reads the flag once at the top and emits two prompt variants:

- Flag on → extended prompt (4 existing arrays + 3 new fields + classification rules + examples)
- Flag off → legacy prompt verbatim (only 4 existing arrays)

The JSON parser tolerates either output. This is the only way to guarantee byte-identical flag-off behavior with the existing extraction.

### 9-3. Rollout

1. Dev/staging on for ≥ 1 week with operator running "包丁" / "ホットカーペット" / "QVCで暖房家電" cases
2. Production on; verify saved-strategy reruns still default to broad and produce byte-identical output for non-tier-4 inputs
3. Remove flag after 2 weeks of stable production data

## 10. Observability

`runGoalAnalysis` logs structured intent on each call:

```
[goal-analysis] userGoal="テレ東マートで売れる包丁..." tier=specific_keyword channels=[txd] specific="包丁" confidence=0.95
```

`channel-taste.loadChannelTasteProfile` logs source_tier + sample_size per call.

`pool-query.ts` logs whether fail-open was suppressed:

```
[pool-query] tier=specific_keyword fail_open=off match_count=3 (no fallback applied)
```

## 11. Testing

### 11-1. Unit / fixture

| Test script | Coverage |
|---|---|
| `npm run test:intent-classifier` | Gemini-call fixtures for 4 tiers + multi-signal cases + ambiguous channel mentions + alias extraction (包丁 → 6 aliases) |
| `npm run test:pool-query-tier4` | tier=specific_keyword disables fail-open. Substring match accepts ANY of (normalized + aliases). Returns < 5 rows when warranted instead of falling back |
| `npm run test:channel-taste` | Tier 1 / 2 / 3 / 4 source selection; sample_size threshold; fit weighting |
| `npm run test:backward-compat-parsed-goal` | undefined new fields → broad behavior; no consumer throws |
| `npm run test:runMDSkill-cache` | When `ctx.parsedGoal` is pre-populated, `runMDSkill("goal_analysis")` returns the cached struct without invoking Gemini |
| `npm run test:tier4-fallback-suppression` | When tier=specific_keyword and pool+fresh return zero items, the `["人気商品","売れ筋","おすすめ"]` broadening at `md-strategy.ts:931` does NOT run |
| `npm run test:intent-projection-flag` | Helper returns legacy struct when flag is off, regardless of caller (workflow vs API route fixtures) |
| `npm run test:alias-blocklist` | Deterministic guard drops over-broad aliases: feed Gemini fixture with `aliases:["ナイフ","キッチン用品"]` → assert "キッチン用品" filtered out, log emitted |
| `npm run test:prompt-flag-gating` | When flag is off, `runGoalAnalysis` emits the legacy prompt only (no classification rules, no alias instructions); response shape contains only the 4 existing arrays |
| `npm run test:competitor-boost-channel-scope` | All 3 functions (`loadHot...`, `loadCategoryFit...`, `applyCompetitorTrendBoost`) honor `channelScope` parameter; SQL `WHERE channel = ANY` is emitted |

### 11-2. Existing regression

- `npm run test:strategy-pool` (CLAUDE.md noted) — tier=broad path output unchanged
- `npm run test:strategy-fresh-search` — fresh search persistence unchanged for tiers 1-3

### 11-3. Manual integration (one-time before flag flip)

- `runGoalAnalysis("テレ東マートで売れる包丁")` against live Gemini — assert tier, channel_scope, specific_keyword shape
- `/api/analytics/md-strategy` end-to-end with "包丁" input — assert ≥ 90% of returned candidates contain "包丁" / "ナイフ" / "knife" substring in name

## 12. Out of Scope (Follow-ups)

- Phase 2: clickable chip with user override of classification
- Multi-keyword support ("칼이나 도마")
- Adaptive alias learning (frequent operator spellings auto-added)
- Per-channel taste profile caching (currently computed per request; may cache once telemetry shows hot channels)
- Extending OA `historical_broadcasts.category` backfill coverage (separate ops effort)

## 13. Open Questions

None at design time. Implementation plan should confirm:

- Exact behavior when `specific_keyword.confidence < 0.7` — proposal: treat as tier 3 (genre) instead, log downgrade
- Whether `channel-taste` boost amount is additive or multiplicative with existing `competitor_trend_boost` — proposal: additive, with combined cap to avoid double-counting
- Alias count cap — proposal: 6 (per §4-2). If user feedback shows misses, raise to 10
- When tier=specific_keyword and `aliases` is empty (Gemini returned only `normalized`), should the fresh search retry with `normalized + " 通販"` style padding? Proposal: yes, but only when first attempt returns < 3 hits

## 14. References

- Architect-advisor critique 2026-05-28 — corrections on `historical_broadcasts.category` coverage and `competitor_fit_analyses` schema
- Codex independent review 2026-05-28 (round 1) — 3 HIGH issues addressed: feature flag coverage gap at 3 direct API call sites, `runMDSkill` cache short-circuit, tier-4 fallback suppression at `md-strategy.ts:931`; plus LC prompt/parser chain
- Codex independent review 2026-05-28 (round 2) — 2 HIGH + 2 MEDIUM addressed: §9-1 chokepoint wording clarified as target state with CI grep guard, §9-3 prompt-level flag gating added (byte-identical off behavior), §4-2 deterministic alias guard (post-parse blocklist filter), §5-3 `applyCompetitorTrendBoost` public signature added
- `CLAUDE.md` § Discovery TV Channel Source, § Strategy ↔ Discovery Pool 統合, § Fit-weighting layer
- `docs/superpowers/specs/2026-05-13-strategy-discovery-pool-integration.md`
- `docs/superpowers/specs/2026-05-13-source-mix-ratio-control-design.md`
