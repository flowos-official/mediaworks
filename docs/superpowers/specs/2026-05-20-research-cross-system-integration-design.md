# Research Cross-System Integration — Design

**Date:** 2026-05-20
**Author:** brainstormed with Claude Opus 4.7
**Status:** Draft — pending user spec review

---

## 1. Context

The Research/Produce pipeline (`/[locale]/(produce)/research` → `/api/analyze` → `/api/analyze/synthesize` → `research_results`) generates a 13-section AI report for uploaded product files. It is **structurally isolated** from the rest of the platform:

- `/api/analyze/synthesize` reads no Supabase data other than the `products` row itself; competitor signals are obtained purely from external Brave/Rakuten searches (`app/api/analyze/synthesize/route.ts:52-60`, `lib/gemini.ts:175-394`).
- `discovered_products` (Discovery pipeline) and `products` (Research pipeline) have **no foreign key** between them; a promising Discovery candidate cannot be promoted into Research without manually re-uploading files.
- `research_results` is read by `md-strategy.ts:1129` only via a fragile full-table scan + 10-char name prefix fuzzy match — a backdoor, not a designed integration.
- Meanwhile, the **Discovery pipeline already integrates with Broadcasts in five places** (`lib/discovery/pool.ts:155`, `recent-broadcast-penalty.ts`, `competitor-trend-boost.ts`, `tv-evidence.ts`, `category-distribution.ts`), so the asymmetry is structural, not incidental.

This document defines a phased integration that connects Research to the rest of the platform without introducing new infrastructure beyond patterns already in production.

## 2. Goals

- **G1** — Synthesize prompt reads broadcasts + competitor_fit_analyses ground truth so the Competitor and Seasonality sections cite real airings rather than Brave-search hallucinations.
- **G2** — Discovery candidates can be promoted into Research with one click, reusing `discovered_products.c_package` instead of forcing a file upload + Vision extraction round trip.
- **G3** — Research output (especially `research_results.broadcast_scripts`) flows into Screenplay generation as a first-class input, not a re-derived snapshot.
- **G4** — MD-Strategy receives Research-sourced products as a fourth canonical `pool_source` ("research"), replacing the current fragile name-match query in `lib/md-strategy.ts:1129`.
- **G5** — Activate the dormant `deep_dive` feedback signal that `lib/discovery/learning.ts:89` already consumes but for which no UI writer exists.

## 3. Non-Goals

- No event bus / queue. Existing `Bearer ${CRON_SECRET}` server-to-server fetch (proven in `/api/analyze` → `/synthesize` and `/api/discovery/enrich` → `/worker`) is sufficient at current scale.
- No external system integration (Slack / Notion / Drive / ERP / PIM). Phase 2.
- No new auth roles. Existing `viewer / member / admin` (`lib/auth/require-user.ts:18-33`) is sufficient.
- No restructuring of route groups. `(document)/products/[id]` stays where it is.
- No fix for separate latent issues discovered during analysis (see §10). Those are tracked as separate PRs.

## 4. Current State — Key Findings (Cited)

Findings from a parallel 5-agent code exploration on 2026-05-20:

### 4.1 Research pipeline inputs

`synthesizeResearch(productInfo, searchResults)` (`lib/gemini.ts:175`) reads exactly:

- `productInfo` (6 fields from `products` row, built at `synthesize/route.ts:36-43`).
- `searchResults` — 13 Brave queries + Rakuten ranking (`lib/brave.ts:44-99`).
- `buildChannelReferencePrompt()` static table (`lib/gemini.ts:198`, `lib/tv-channels.ts:42`).

No queries to `broadcasts`, `broadcast_products`, `historical_broadcasts`, `competitor_fit_analyses`, or `discovered_products`. Verified by grep.

### 4.2 Discovery pipeline already broadcasts-aware

Five readers of broadcast tables exist in Discovery:

| File | Read | Effect |
|---|---|---|
| `lib/discovery/pool.ts:155` (Pass C) | `broadcasts` last 30d | Sources QVC/ShopCh candidates into pool |
| `lib/discovery/recent-broadcast-penalty.ts:58` | `broadcasts` QVC last 30d | −10 to `tvFitScore` for matched product IDs |
| `lib/discovery/competitor-trend-boost.ts:49,92` | `broadcasts` + `competitor_fit_analyses` | +0..12.5 boost weighted by avg fit_score |
| `lib/discovery/tv-evidence.ts:234-248` | `broadcasts` + `historical_broadcasts` | Evidence mining → `discovered_products.tv_evidence` |
| `lib/discovery/category-distribution.ts:48-77` | `broadcasts` + `historical_broadcasts` | UI stats |

### 4.3 `c_package` richer than Vision extraction

`discovered_products.c_package` (jsonb) contains: `manufacturer`, `wholesale_estimate`, `moq_hint`, `tv_script_draft`, `sns_trend`. These map directly to Research report sections (COGS, Competitor, BroadcastScript) — the Gemini Vision step in `/api/analyze` would be redundant work for a promoted Discovery candidate.

### 4.4 `deep_dive` learning signal — dormant

- Schema: `product_feedback.action` CHECK constraint includes `'deep_dive'` (`supabase/migrations/2026-04-18_discovery_system.sql:75`).
- Reader: `lib/discovery/learning.ts:89-99` joins `product_feedback WHERE action='deep_dive'` and treats it as a success signal.
- Writer: none. `components/discovery/FeedbackButtons.tsx:7` exposes only the four explicit actions; no code path writes `deep_dive`.

### 4.5 `md-strategy` reads `research_results` via fuzzy match

`lib/md-strategy.ts:1129` does `select("*").from("research_results")` (full-table scan), then matches by `raw_json.product_name.slice(0, 10)` substring at line 1195-1198. This enriches the existing-TV-products context for skill prompts but is fragile (10-char name collision) and does not feed Discovery candidates.

### 4.6 Vercel Workflow DevKit already in use

Three durable workflows exist: `screenplayWorkflow`, `mdStrategyWorkflow`, `liveCommerceWorkflow` (`lib/workflows/*.workflow.ts`). Manifest at `public/.well-known/workflow/v1/manifest.json`. Adding new durable workflows is an established pattern.

### 4.7 5 of 13 report sections live only in `raw_json`

Dedicated columns: `marketability_*`, `demographics`, `seasonality`, `cogs_estimate`, `influencers`, `content_ideas`, `competitor_analysis`, `recommended_price_range`, `broadcast_scripts`, `japan_export_fit_score`.

Missing columns (live only in `raw_json.research`): `distribution_channels`, `pricing_strategy`, `marketing_strategy`, `korea_market_fit`, `live_commerce`. Merge logic at `app/api/products/[id]/route.ts:35-39` is the only recovery path.

## 5. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ Discovery (already broadcasts-aware, 5 readers)          │
│   discovered_products.c_package ──────────────┐          │
└────────────────────────────────────────────────│─────────┘
                                                 │ promote (P1)
                                                 ▼
┌─────────────────────────────────────────────────────────┐
│ Research                                                 │
│   products ◄── discovered_product_id FK (new)           │
│      │                                                   │
│      ▼                                                   │
│   /api/analyze/synthesize ◄─── broadcastContext (P2)    │
│      │                       └── lib/research/          │
│      ▼                           competitor-context.ts  │
│   research_results                                       │
└──────────────│──────────────────────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
  Screenplay (P3)  MD-Strategy (P4)
  brief from       pool_source: 'research'
  broadcast_scripts  via pool-query.ts
```

## 6. Detailed Design

### 6.1 Schema Changes (single migration)

`supabase/migrations/2026-05-20_research_discovery_link.sql`:

```sql
-- Link a research'd product back to its discovery origin (nullable, additive)
ALTER TABLE products
  ADD COLUMN discovered_product_id uuid NULL
  REFERENCES discovered_products(id) ON DELETE SET NULL;

CREATE INDEX idx_products_discovered_product_id
  ON products (discovered_product_id)
  WHERE discovered_product_id IS NOT NULL;

-- Mark research's input mode
ALTER TABLE products
  ADD COLUMN ingest_source text NOT NULL DEFAULT 'file_upload'
  CHECK (ingest_source IN ('file_upload', 'discovery_promotion', 'manual_url'));
```

RLS: `products` is already in Group B (`supabase/migrations/2026-05-13_auth_rls_tight.sql`) — member/admin read+write, viewer no access. New columns inherit. No policy changes needed.

Rollback: drop the two columns and the index. Fully reversible.

### 6.2 P2 — Synthesize broadcast-context injection

**New module:** `lib/research/competitor-context.ts`

Exports `loadBroadcastContext(category: string | null, productName: string): Promise<BroadcastContext>`:

- Returns `null` if `category` is null (no useful query).
- Otherwise runs three parallel Supabase queries via `getServiceClient()`:
  1. `broadcasts` JOIN `broadcast_products` WHERE category = ? AND air_date >= now() - interval '60 days' → top 10 by frequency. Capture `channel`, `program_title`, `brand_name`, `start_time`.
  2. `historical_broadcasts` WHERE category = ? AND air_date >= now() - interval '60 days' → top 10 by frequency.
  3. `competitor_fit_analyses` WHERE category = ? AND created_at >= now() - interval '90 days` → AVG(fit_score), COUNT(*), top 3 by fit_score with `summary` text.
- Returns `{ recentAirings: [...], oaAirings: [...], operatorFit: { avg, count, top3 } }`.

**Inject into Gemini prompt:**

- `lib/gemini.ts:175` — change signature to `synthesizeResearch(productInfo, searchResults, broadcastContext?)`.
- After the `searchResults` rendering loop at `lib/gemini.ts:194`, append a new section:

```
## 実測 経쟁사データ (社内DB 由来)
直近60日のQVC + ShopCh + OA 7局における同カテゴリ放送:
- 総スロット数: N
- 上位ブランド: A, B, C
- 代表番組タイトル: ...

運営者キュレーション (competitor_fit_analyses):
- 平均適合度スコア: NN/100 (n=M, 90日窓)
- 高評価サンプル: [簡単な要約 3件]

以下の Competitor / Seasonality セクションでは、
上記の実測データを優先して引用し、Brave 検索結果は補助としてのみ使用すること。
```

- `app/api/analyze/synthesize/route.ts:53-60` — between `runProductResearch()` and `synthesizeResearch()`, call `loadBroadcastContext(product.category, product.name)` and pass result as third arg.

**Cost impact:** 3 Supabase queries (~50ms combined). No external API spend.
**Failure mode:** If any of the 3 queries fails, log + pass `null` to Gemini. Report still generates, just without ground-truth context.

### 6.3 P1 + P5 — Discovery → Research promotion (combined PR)

**New route:** `app/api/discovery/[productId]/promote-to-research/route.ts`

Authentication: `requireUser(['member', 'admin'])`.

Body: none (productId is the path param).

Logic:

1. Load `discovered_products` row by `[productId]`. 404 if missing.
2. Check `enrichment_status === 'completed'` — if not, return 409 `{ error: 'c_package not ready, run enrichment first' }`.
3. Idempotency check: if any `products` row exists with `discovered_product_id = [productId]`, return 200 with `{ productId: existing, alreadyPromoted: true }`.
4. Build `products` insert from `discovered_products.c_package` + base columns. **The exact sub-structure of `c_package` (verified via `lib/discovery/enrich-agent.ts` schema) must be confirmed at implementation time; the mapping below is the intent, not a final field-by-field contract:**
   ```
   name             ← dp.name
   description      ← summary derived from c_package (tv_script_draft + sns_trend),
                       falling back to dp.tv_fit_reason if c_package incomplete
   category         ← dp.category
   features         ← string[] derived from c_package (manufacturer, moq_hint, etc.)
   price_range      ← format from dp.price_jpy
   target_market    ← derive from category mapping
   status           ← 'extracted' (skips Vision phase)
   ingest_source    ← 'discovery_promotion'
   discovered_product_id ← dp.id
   ```
5. Internal fetch: `POST /api/analyze/synthesize` with `Authorization: Bearer ${CRON_SECRET}` and body `{ productId: newProductId }`. Fire-and-forget; return immediately.
6. **P5:** INSERT `product_feedback` row `{ discovered_product_id: dp.id, action: 'deep_dive', reason: 'promoted_to_research' }`. This activates the dormant learning signal at `lib/discovery/learning.ts:89`.
7. Return `{ productId: newProductId, alreadyPromoted: false }`.

**UI:** `components/discovery/IntegrationActions.tsx:20` — add button next to existing actions:

```tsx
<Button
  variant="outline"
  size="sm"
  disabled={product.enrichment_status !== 'completed' || promoting}
  onClick={async () => {
    setPromoting(true);
    const res = await fetch(`/api/discovery/${product.id}/promote-to-research`, { method: 'POST' });
    const { productId } = await res.json();
    router.push(`/${locale}/products/${productId}`);
  }}
>
  リサーチ実施
</Button>
```

Disabled state when `enrichment_status !== 'completed'` is required because P1 reads `c_package`. The existing enrichment cron + manual trigger handle filling it.

### 6.4 P3 — Research → Screenplay button + brief enrichment

**UI:** `app/[locale]/(document)/products/[id]/page.tsx` — add button (member/admin only via server-side check):

```tsx
<Button onClick={async () => {
  const res = await fetch('/api/screenplays', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id }),
  });
  const { id } = await res.json();
  router.push(`/${locale}/screenplays/${id}`);
}}>
  この商品で台本を生成
</Button>
```

**API enrichment:** `app/api/screenplays/route.ts:79` — after `briefFromProduct(product)`, query `research_results` by `product_id`. If found and `broadcast_scripts.sec60` exists, set:

```ts
brief.notes = research.broadcast_scripts.sec60;
brief.customization = brief.customization ?? {};
brief.customization.targetDemographics = research.demographics;
```

Failure mode: `research_results` not found → brief used as-is (no enrichment). The brief always works because `briefFromProduct` already covers it.

### 6.5 P4 — MD-Strategy `pool_source: 'research'`

**Type changes:** `lib/strategy/source-attribution.ts` and `lib/strategy/pool-query.ts`:

- `AttributablePoolItem.pool_source: 'discovery_pool' | 'fresh_search' | 'seed' | 'research'`
- `PoolRow` interface unchanged; new helper returns research-sourced items separately.

**New module:** `lib/strategy/research-seed.ts`

Exports `queryResearchPool(input: PoolQueryInput): Promise<PoolRow[]>`:

- Reads `products` JOIN `research_results` WHERE:
  - `products.category` fuzzy matches `input.uiCategory` (reuse `mapUiCategoryToSalesCategories`).
  - `research_results.japan_export_fit_score >= 60`.
  - `products.status = 'completed'`.
  - `products.created_at >= STRATEGY_POOL_LOOKBACK_DAYS env (default 60d)`.
- Maps each row to `PoolRow` shape with `pool_source: 'research'`. Synthetic `tv_fit_score = research.japan_export_fit_score`. `discovered_product_id` set if the product was originally promoted from Discovery (via the new FK).
- Honors same fail-open thresholds as `queryDiscoveredPool` (R4, R5).

**Integration into `discoverNewProducts`:** `lib/md-strategy.ts:579-606` — after `queryDiscoveredPool` call:

```ts
const researchPool = await queryResearchPool({ /* same input */ });
// Merge into cappedPool with sort: discovery_pool first, then research, then fresh_search.
```

Cap research items at `Math.floor(TARGET * 0.2)` so they supplement, not dominate, the Discovery pool. (e.g. TARGET=30 → max 6 research items; TARGET=12 → max 2.)

**Prompt rendering:** `lib/md-strategy.ts:826-832` — extend sourceTag ternary:

```ts
const sourceTag =
  item.pool_source === 'discovery_pool' ? '🟣 [Discovery]' :
  item.pool_source === 'research'       ? '🟡 [Research]' :
  item.pool_source === 'seed'           ? '🔵 [Seed]' :
                                          '🟢 [Fresh]';
```

**Attribution:** `lib/strategy/source-attribution.ts:100` — the existing URL/itemCode/name matchers work generically. Add a `byProductId` fallback for `pool_source: 'research'` where the URL is a `/products/[id]` internal link.

**Deprecate (separate PR, not this one):** the fragile fuzzy-match query at `lib/md-strategy.ts:1129,1195-1198` becomes redundant once `research` is a first-class pool source. Removing it is **out of scope for this design** to keep the change reviewable.

## 7. Data Flow After Integration

```
Discovery candidate (enrichment_status=completed)
  ↓ user clicks "リサーチ実施"
POST /api/discovery/[id]/promote-to-research
  ↓
products INSERT (status=extracted, ingest_source=discovery_promotion,
                  discovered_product_id=dp.id)
product_feedback INSERT (action=deep_dive)  ← P5
  ↓
POST /api/analyze/synthesize (internal, Bearer CRON_SECRET)
  ↓
loadBroadcastContext(category, name)  ← P2
  ↓ {recentAirings, oaAirings, operatorFit}
synthesizeResearch(productInfo, searchResults, broadcastContext)
  ↓
research_results INSERT
  ↓
UI navigates to /[locale]/products/[productId]
  ↓
User clicks "台本生成"  ← P3
  ↓
POST /api/screenplays (productId)
  ↓ briefFromProduct + research_results enrichment
screenplayWorkflow.start()
  ↓
screenplays row + AI-generated script

Meanwhile, MD-Strategy picks up this product as research-source candidate:
  ↓
mdStrategyWorkflow → runDiscoveryStep
  ↓
queryDiscoveredPool + queryResearchPool (P4)
  ↓
Gemini sees [Research] tagged products alongside [Discovery]
```

## 8. Error Handling

| Failure | Handling |
|---|---|
| P2: `loadBroadcastContext` query fails | Log warning, pass `null` to Gemini. Report still generates without ground-truth context. |
| P1: `c_package` not ready (`enrichment_status != 'completed'`) | API returns 409 with explanatory message. UI button is pre-disabled. |
| P1: synthesize fire-and-forget fetch fails | `products.status` stays at `extracted`. Existing 5s UI polling (`ProductList.tsx:43`) detects the stuck state. Recovery via admin "retry synthesis" (does not exist yet — out of scope; manual fix via re-promote). |
| P1: duplicate promotion | Idempotency check returns existing `productId` with `alreadyPromoted: true`. UI navigates as usual. |
| P3: `research_results` not found | Brief used as-is. Screenplay generates from `briefFromProduct` only. |
| P4: research pool query fails | Logged, pool is just `[]`. Discovery pool fills as before. |
| P4: Gemini hallucinates URL for research-sourced item | Source attribution `byProductId` falls back to name match → marked as `fresh_search` (existing safety net). |

## 9. Testing Strategy

The project has no test framework configured (`CLAUDE.md`). Verification is by:

1. **Manual smoke test per P** (in order):
   - **P2:** Upload a product whose category matches active broadcasts. Inspect `research_results.competitor_analysis` JSON for real brand names from `broadcasts.brand_name`.
   - **P1:** From Discovery home page, click "リサーチ実施" on a candidate with `enrichment_status='completed'`. Verify: `products` row created with `discovered_product_id` FK set, `product_feedback.action='deep_dive'` row created, redirect to product detail page, synthesis completes within 5 min.
   - **P3:** On product detail page, click "台本生成". Verify screenplay row created with `product_id` FK, brief contains research-derived content.
   - **P4:** Run MD-Strategy with a category that has Research-completed products. Verify Gemini output includes 🟡 [Research]-tagged items.

2. **Idempotency check** for P1: click promote twice; second should return `alreadyPromoted: true`.

3. **Data integrity check** post-deploy:
   ```sql
   SELECT count(*) FROM products WHERE discovered_product_id IS NOT NULL;
   SELECT count(*) FROM product_feedback WHERE action='deep_dive';
   ```

4. **Type check:** `npx tsc --noEmit` after each PR (per global CLAUDE.md rule).

## 10. Out of Scope (Tracked Separately)

These were discovered during analysis but are not part of this design:

- **OOS-1 — Latent auth bug:** `/api/upload` triggers `/api/analyze` via fire-and-forget fetch with no cookies and no `Bearer ${CRON_SECRET}` (`app/api/upload/route.ts:162`). `requireUser` should reject this but production traffic works — a hidden bypass path likely exists. Needs separate security investigation.
- **OOS-2 — Two divergent category whitelists:** `channel_categories` DB seed has `ビューティー` (with elongation mark); `components/broadcasts/UnifiedDayDetailPanel.tsx:24-47` has `ビューティ` (no elongation). Ingest gate and display gate use different vocabularies. Separate consolidation PR.
- **OOS-3 — `raw_json` only sections:** 5 of 13 report sections (`distribution_channels`, `pricing_strategy`, `marketing_strategy`, `korea_market_fit`, `live_commerce`) have no dedicated DB columns. P4 must read these via `raw_json` parsing. A separate normalization migration is recommended but not required for this design to land.
- **OOS-4 — Deprecate `md-strategy.ts:1129` fuzzy match:** Once P4 lands, the fragile name-match read is redundant. Remove in a follow-up PR.
- **OOS-5 — Retry synthesis admin button:** P1 inherits the existing fire-and-forget pattern's lack of UI retry. Adding admin retry for failed synthesis is useful but not blocking.

## 11. Build Order

1. **Migration only** (`2026-05-20_research_discovery_link.sql`) — 5 min, rollback-safe.
2. **P2 — Broadcast context injection** — highest quality lift, zero UI work, no schema dependency on step 1. Can ship independently.
3. **P1 + P5 combined PR** — Discovery promotion + dormant `deep_dive` activation. Depends on migration.
4. **P3 — Screenplay button + brief enrichment** — small, demonstrates the read-flow pattern.
5. **P4 — MD-Strategy research pool** — largest scope. Ships last so its behavior is verified against real promoted products from step 3.

## 12. Open Questions

- **Q1:** In P4, should research-sourced items count toward `pool_only` decision in `decideDiscoveryStrategy`? Currently the strategy mode is decided by `poolSize` alone. If research adds 5 items, that could shift the decision from `fresh_only` → `pool_filled`. Default: count them, but cap their share at 20%.
- **Q2:** In P2, should `loadBroadcastContext` also feed `c_package` data when the product was promoted from Discovery? Currently we'd be double-feeding: the product was already discovered with TV evidence, then synthesize re-reads broadcasts. Decision: yes, but use the FK to deduplicate — if `products.discovered_product_id` is set, prefer the candidate's `tv_evidence` over re-querying.
- **Q3:** Should `pool_source: 'seed'` orphan be cleaned up in this PR or deferred? It's listed in the type union (`lib/md-strategy.ts:441`) but `source-attribution.ts` never produces it. Decision: deferred. It's not actively broken, just misleading.

## 13. Acceptance Criteria

This design is complete when:

- [ ] Schema linkage between Research and Discovery exists (no FK violation possible).
- [ ] Synthesize prompt observably references broadcasts data (manual inspection of a generated report).
- [ ] One-click Discovery → Research promotion works without file upload.
- [ ] `product_feedback.action='deep_dive'` rows exist after promotions (verifying learning loop activation).
- [ ] Research → Screenplay button creates a screenplay with research-derived content.
- [ ] MD-Strategy Gemini prompt contains 🟡 [Research] tagged items when applicable.
- [ ] No regression: existing file-upload Research flow still works unchanged.
- [ ] `npx tsc --noEmit` passes.
