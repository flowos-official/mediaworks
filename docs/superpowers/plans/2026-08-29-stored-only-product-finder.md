# Stored-Only Product Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an on-demand product finder that ranks current stored evidence without making external searches, preserves every supporting knowledge item, and keeps profitability unknown unless internal data supports it.

**Architecture:** Add a recommendation-run read model on top of the intelligence foundation. Candidate retrieval and ranking are deterministic TypeScript services; an LLM is optional for prose only and never creates candidates or scores. The new `/analytics/product-finder` surface does not use the legacy external-search `/api/recommend` route.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase, Zod 4, React 19, next-intl, `tsx` tests.

**Spec:** `docs/superpowers/specs/2026-08-29-on-demand-data-intelligence-pipeline-design.md`

## Global Constraints

- Requires completion of `docs/superpowers/plans/2026-08-29-data-intelligence-foundation.md`.
- Default and only mode in this plan is `stored_only`; Brave, Rakuten, generic `fetch()`, and live web tools are forbidden in the product-finder service.
- The system may recommend with market evidence when internal performance is absent, but it must show profitability as unknown.
- Competitor sales claims and demand proxies never become actual revenue or unit sales.
- No recommendation action auto-creates Research or Screenplay output.
- Display component scores and confidence separately; do not present a saturated universal 0–100 truth score.

---

## File Map

- `supabase/migrations/20260829140000_product_finder_runs.sql` — immutable runs, ranked items, and user decisions.
- `lib/product-finder/types.ts` — request/result and score-axis contracts.
- `lib/product-finder/request.ts` — strict Zod request parser.
- `lib/product-finder/candidates.ts` — stored evidence/insight candidate loader.
- `lib/product-finder/ranking.ts` — pure normalization and ranking.
- `lib/product-finder/run.ts` — orchestration, persistence, and knowledge snapshot.
- `app/api/product-finder/route.ts` and run/decision routes — authenticated API.
- `app/[locale]/(market)/analytics/product-finder/page.tsx` — new page.
- `components/product-finder/*` — query form, axis cards, evidence list, and actions.

---

### Task 1: Recommendation Run Schema

**Files:**
- Create: `supabase/migrations/20260829140000_product_finder_runs.sql`
- Create: `scripts/test-product-finder-schema.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `product_recommendation_runs`, `product_recommendation_items`, and `product_recommendation_decisions`.
- Each completed run has exactly one `knowledge_snapshot_id` and each item points to a canonical product.

- [ ] **Step 1: Write the failing migration test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const sql = readFileSync("supabase/migrations/20260829140000_product_finder_runs.sql", "utf8").toLowerCase();
for (const table of ["product_recommendation_runs", "product_recommendation_items", "product_recommendation_decisions"]) {
  assert.ok(sql.includes(`create table ${table}`));
}
assert.ok(sql.includes("mode = 'stored_only'"));
assert.ok(sql.includes("expected_contribution_profit_jpy numeric"));
assert.ok(sql.includes("decision in ('interested','excluded')"));
console.log("PASS: product finder schema");
```

- [ ] **Step 2: Verify ENOENT failure**

Run: `npx tsx scripts/test-product-finder-schema.ts`

Expected: FAIL because the migration is absent.

- [ ] **Step 3: Create the schema**

```sql
create table product_recommendation_runs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references profiles(id) on delete restrict,
  mode text not null default 'stored_only' check (mode = 'stored_only'),
  query_json jsonb not null,
  status text not null check (status in ('running','completed','failed')),
  algorithm_version text not null,
  knowledge_snapshot_id uuid references knowledge_snapshots(id) on delete restrict,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  result_count integer not null default 0 check (result_count >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status = 'completed') = (knowledge_snapshot_id is not null and completed_at is not null))
);

create table product_recommendation_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references product_recommendation_runs(id) on delete cascade,
  canonical_product_id uuid not null references canonical_products(id) on delete restrict,
  rank integer not null check (rank > 0),
  opportunity_index numeric(6,5) not null check (opportunity_index between 0 and 1),
  expected_contribution_profit_jpy numeric,
  axes jsonb not null,
  confidence jsonb not null,
  reasons jsonb not null,
  risks jsonb not null,
  missing_data jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, rank),
  unique (run_id, canonical_product_id)
);

create table product_recommendation_decisions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references product_recommendation_items(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete restrict,
  decision text not null check (decision in ('interested','excluded')),
  reason text,
  created_at timestamptz not null default now(),
  unique (item_id, user_id)
);

create index product_recommendation_runs_user_idx on product_recommendation_runs(created_by, created_at desc);
create index product_recommendation_items_run_idx on product_recommendation_items(run_id, rank);

alter table product_recommendation_runs enable row level security;
alter table product_recommendation_items enable row level security;
alter table product_recommendation_decisions enable row level security;

create policy product_recommendation_runs_owner_read on product_recommendation_runs for select to authenticated using (created_by = auth.uid());
create policy product_recommendation_items_owner_read on product_recommendation_items for select to authenticated using (
  exists (select 1 from product_recommendation_runs r where r.id = run_id and r.created_by = auth.uid())
);
create policy product_recommendation_decisions_owner_read on product_recommendation_decisions for select to authenticated using (user_id = auth.uid());
```

- [ ] **Step 4: Add command, run checks, and commit**

Add `"test:product-finder-schema": "tsx scripts/test-product-finder-schema.ts"`.

Run: `npm run test:product-finder-schema && npm run test:migrations`

Expected: both PASS.

```bash
git add package.json scripts/test-product-finder-schema.ts supabase/migrations/20260829140000_product_finder_runs.sql
git commit -m "feat(product-finder): add recommendation run schema"
```

---

### Task 2: Strict Request and Result Contracts

**Files:**
- Create: `lib/product-finder/types.ts`
- Create: `lib/product-finder/request.ts`
- Create: `scripts/test-product-finder-request.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `ProductFinderQuery`, `ProductFinderResult`, `ScoreAxis`, and `parseProductFinderQuery()`.
- The parser rejects any `mode` except `stored_only` and strips no unknown fields silently.

- [ ] **Step 1: Write request parsing tests**

```ts
assert.deepEqual(parseProductFinderQuery({ category: "家電", targetCustomer: "50代女性" }), {
  category: "家電",
  targetCustomer: "50代女性",
  priceMinJpy: undefined,
  priceMaxJpy: undefined,
  targetMarginRate: undefined,
  desiredFeatures: [],
  excludedTerms: [],
  limit: 10,
  mode: "stored_only",
});
assert.throws(() => parseProductFinderQuery({ category: "家電", mode: "supplemented" }));
assert.throws(() => parseProductFinderQuery({ category: "家電", surpriseField: true }));
```

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-product-finder-request.ts`

Expected: FAIL resolving `lib/product-finder/request`.

- [ ] **Step 3: Define exact contracts**

```ts
export type AxisStatus = "measured" | "proxy" | "unknown";
export interface ScoreAxis { key: "market_demand" | "company_fit" | "profitability" | "competition_headroom" | "broadcast_fit"; status: AxisStatus; normalized: number | null; label: string; evidenceIds: string[] }
export interface ProductFinderQuery { category?: string; targetCustomer?: string; priceMinJpy?: number; priceMaxJpy?: number; targetMarginRate?: number; desiredFeatures: string[]; excludedTerms: string[]; limit: number; mode: "stored_only" }
export interface ProductFinderItem { id: string; canonicalProductId: string; rank: number; name: string; category: string | null; opportunityIndex: number; expectedContributionProfitJpy: number | null; axes: ScoreAxis[]; confidence: { level: "high" | "medium" | "low"; coverage: number }; reasons: string[]; risks: string[]; missingData: string[] }
export interface ProductFinderResult { runId: string; mode: "stored_only"; generatedAt: string; query: ProductFinderQuery; candidateCount: number; items: ProductFinderItem[] }
```

- [ ] **Step 4: Implement strict Zod parsing**

The schema uses `.strict()`, trims strings, limits text fields to 200 characters, arrays to 20 items, `limit` to 5–30, price values to non-negative integers, and margin to 0–100. Default `mode` to `stored_only` with `z.literal("stored_only")`.

- [ ] **Step 5: Run and commit**

Add `"test:product-finder-request": "tsx scripts/test-product-finder-request.ts"`.

Run: `npm run test:product-finder-request && npx tsc --noEmit`

```bash
git add package.json lib/product-finder/types.ts lib/product-finder/request.ts scripts/test-product-finder-request.ts
git commit -m "feat(product-finder): define strict stored-only request"
```

---

### Task 3: Stored Evidence Candidate Loader

**Files:**
- Create: `lib/product-finder/candidates.ts`
- Create: `scripts/test-product-finder-candidates.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes Task 1 foundation tables.
- Produces `loadStoredCandidates(sb, query, dataCutoff)` and the pure `assembleCandidate()` mapper.

- [ ] **Step 1: Write the candidate assembly test**

Feed evidence containing price, TV airing count, review count, and a seller sales claim. Assert that the claim remains `source_claim`, airings/reviews remain `proxy`, and no `actual_sales` field appears.

```ts
assert.equal(candidate.signals.tvAirings?.evidenceClass, "proxy");
assert.equal(candidate.signals.reviewCount?.evidenceClass, "proxy");
assert.equal(candidate.signals.sellerSalesClaim?.evidenceClass, "source_claim");
assert.equal("actualSales" in candidate.signals, false);
```

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-product-finder-candidates.ts`

Expected: module resolution failure.

- [ ] **Step 3: Implement the pure assembler**

```ts
export interface StoredSignal<T> {
  value: T;
  evidenceClass: "verified" | "source_claim" | "proxy" | "inferred" | "internal_input";
  confidence: number;
  observedAt: string;
  evidenceItemId: string;
}
export interface CanonicalProductRow { id: string; display_name: string; normalized_category: string | null }
export interface EvidenceRow { id: string; subject_id: string; predicate: string; value_json: unknown; value_state: string; evidence_class: StoredSignal<unknown>["evidenceClass"]; confidence: number; observed_at: string; revoked_at: string | null }
export interface StoredCandidate {
  canonicalProductId: string;
  name: string;
  category: string | null;
  evidenceIds: string[];
  signals: {
    priceJpy?: StoredSignal<number>;
    tvAirings?: StoredSignal<number>;
    recentAirings?: StoredSignal<number>;
    reviewCount?: StoredSignal<number>;
    sellerSalesClaim?: StoredSignal<string | number>;
    internalProfitJpy?: StoredSignal<number>;
    internalMarginRate?: StoredSignal<number>;
    broadcastPatternSample?: StoredSignal<number>;
  };
}
export function assembleCandidate(product: CanonicalProductRow, evidence: EvidenceRow[]): StoredCandidate;
```

When multiple known items exist for one predicate, select the non-stale item with highest evidence-class precedence (`internal_input`, `verified`, `source_claim`, `proxy`, `inferred`), then confidence, then observation time. Preserve all used IDs.

- [ ] **Step 4: Implement the database loader**

`loadStoredCandidates()` queries only Supabase tables, applies category/price/excluded-term filters, limits the pre-rank set to 500, loads the latest relevant evidence in pages, and returns assembled candidates. It must not import `@/lib/brave`, `@/lib/rakuten`, Gemini SDKs, or call `fetch`.

- [ ] **Step 5: Add a static no-network assertion and run**

The test reads `candidates.ts` and asserts those imports and `fetch(` are absent.

Add `"test:product-finder-candidates": "tsx scripts/test-product-finder-candidates.ts"`.

Run: `npm run test:product-finder-candidates`

- [ ] **Step 6: Commit**

```bash
git add package.json lib/product-finder/candidates.ts scripts/test-product-finder-candidates.ts
git commit -m "feat(product-finder): load candidates from stored evidence"
```

---

### Task 4: Transparent Ranking Without False Profit

**Files:**
- Create: `lib/product-finder/ranking.ts`
- Create: `scripts/test-product-finder-ranking.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes `StoredCandidate[]` and `ProductFinderQuery`.
- Produces `rankStoredCandidates(candidates, query): RankedCandidate[]`.

- [ ] **Step 1: Write ranking tests for known and unknown profit**

```ts
const ranked = rankStoredCandidates(fixtures, query);
assert.equal(ranked.find((x) => x.id === "no-cost")?.expectedContributionProfitJpy, null);
assert.equal(ranked.find((x) => x.id === "no-cost")?.axes.find((axis) => axis.key === "profitability")?.status, "unknown");
assert.equal(ranked[0]?.id, "known-profitable");
assert.ok(ranked.every((x) => x.opportunityIndex >= 0 && x.opportunityIndex <= 1));
assert.ok(new Set(ranked.map((x) => x.opportunityIndex)).size > 1);
```

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-product-finder-ranking.ts`

- [ ] **Step 3: Implement category-relative normalization**

Use percentile ranks over the current candidate set instead of clamping raw sums to 100. Return `null` for a dimension with no evidence. Compute:

- market demand from recent airings, total airings, and review count proxies;
- company fit from internal category/price insight only when present;
- profitability from actual internal profit or calculable internal cost/price only;
- competition headroom from stored category density insight;
- broadcast fit from analyzed pattern sample and TV evidence.

The internal `opportunityIndex` is the weighted mean of available non-profit axes (`0.40 demand + 0.25 company fit + 0.20 broadcast fit + 0.15 competition headroom`, re-normalized over available weights). If profitability is known, sort by expected contribution profit first and opportunity index second; otherwise sort by opportunity index. Confidence is evidence coverage multiplied by average evidence confidence.

```ts
export interface RankedCandidate {
  id: string;
  canonicalProductId: string;
  opportunityIndex: number;
  expectedContributionProfitJpy: number | null;
  axes: ScoreAxis[];
  confidence: { level: "high" | "medium" | "low"; coverage: number };
  evidenceIds: string[];
}
export function rankStoredCandidates(candidates: StoredCandidate[], query: ProductFinderQuery): RankedCandidate[];
```

- [ ] **Step 4: Ensure no unknown-to-zero coercion**

Reject `Number(signal ?? 0)` and truthy fallbacks for score inputs in the static portion of the test. Missing data must enter the axis as `{ status: "unknown", normalized: null }`.

- [ ] **Step 5: Run and commit**

Add `"test:product-finder-ranking": "tsx scripts/test-product-finder-ranking.ts"`.

Run: `npm run test:product-finder-ranking && npx tsc --noEmit`

```bash
git add package.json lib/product-finder/ranking.ts scripts/test-product-finder-ranking.ts
git commit -m "feat(product-finder): rank stored candidates transparently"
```

---

### Task 5: Stored-Only Run Service and Knowledge Snapshot

**Files:**
- Create: `lib/product-finder/run.ts`
- Create: `scripts/test-product-finder-run.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes Tasks 2–4 and `createKnowledgeSnapshot()` from the foundation.
- Produces the shared database-only runner plus a stored-only wrapper. The controlled-input plan later extends the runner's mode without changing retrieval or ranking.

- [ ] **Step 1: Write a fake-repository orchestration test**

Assert the service creates a running row, loads candidates once, ranks once, creates one `stored_only` knowledge snapshot using all displayed evidence IDs, inserts ranked items, and marks the run completed. On item insert failure it marks the run failed and returns no completed result.

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-product-finder-run.ts`

- [ ] **Step 3: Implement the application service**

```ts
export async function runProductFinderFromStoredEvidence(
  sb: SupabaseClient,
  userId: string,
  query: ProductFinderQuery,
  options: { mode: "stored_only" },
): Promise<ProductFinderResult>;

export async function runStoredProductFinder(
  sb: SupabaseClient,
  userId: string,
  query: ProductFinderQuery,
): Promise<ProductFinderResult>;
```

`runStoredProductFinder()` delegates to `runProductFinderFromStoredEvidence()` with `{ mode: "stored_only" }`. Neither function accepts provider dependencies or imports external-search modules.

Set `dataCutoff` once at the start. `reasons`, `risks`, and `missingData` are deterministic templates derived from axes and evidence classes; do not call Gemini in v1. Save no more than `query.limit` items. Mark a run `completed` only after the knowledge snapshot and every item exist.

- [ ] **Step 4: Run and commit**

Add `"test:product-finder-run": "tsx scripts/test-product-finder-run.ts"`.

Run: `npm run test:product-finder-run && npx tsc --noEmit`

```bash
git add package.json lib/product-finder/run.ts scripts/test-product-finder-run.ts
git commit -m "feat(product-finder): persist stored-only recommendation runs"
```

---

### Task 6: Authenticated Product Finder APIs

**Files:**
- Create: `app/api/product-finder/route.ts`
- Create: `app/api/product-finder/runs/[id]/route.ts`
- Create: `app/api/product-finder/runs/[runId]/items/[itemId]/decision/route.ts`
- Create: `scripts/test-product-finder-routes.ts`
- Modify: `package.json`

**Interfaces:**
- `POST /api/product-finder` accepts only the strict stored-only query.
- `GET /api/product-finder/runs/:id` returns only a run owned by the current user.
- Decision route upserts `interested` or `excluded`; it does not trigger downstream work.

- [ ] **Step 1: Write static auth and no-network route tests**

Assert all routes call `requireUser`, the POST imports `runStoredProductFinder`, none import Brave/Rakuten/Gemini, and no route calls a Research or Screenplay endpoint.

- [ ] **Step 2: Verify failure because routes are absent**

Run: `npx tsx scripts/test-product-finder-routes.ts`

- [ ] **Step 3: Implement POST and GET**

POST returns 400 for invalid queries, 409 with `{ code: "explicit_supplement_required" }` for a `supplemented` mode attempt, 201 on success, and 500 with `{ code: "product_finder_failed" }` after the service records failure. GET scopes by both run ID and `created_by`.

- [ ] **Step 4: Implement the decision mutation**

Validate `{ decision: "interested" | "excluded", reason?: string }`; verify the item belongs to a run owned by the user; upsert on `(item_id,user_id)`; return the decision only. No product promotion, Research, or selection row is created.

- [ ] **Step 5: Run and commit**

Add `"test:product-finder-routes": "tsx scripts/test-product-finder-routes.ts"`.

Run: `npm run test:product-finder-routes && npx tsc --noEmit`

```bash
git add package.json app/api/product-finder scripts/test-product-finder-routes.ts
git commit -m "feat(product-finder): add stored-only APIs"
```

---

### Task 7: Product Finder UI and Navigation

**Files:**
- Create: `app/[locale]/(market)/analytics/product-finder/page.tsx`
- Create: `components/product-finder/ProductFinderClient.tsx`
- Create: `components/product-finder/ProductFinderForm.tsx`
- Create: `components/product-finder/ProductFinderResultCard.tsx`
- Create: `components/product-finder/EvidenceList.tsx`
- Create: `scripts/test-product-finder-view.ts`
- Modify: `lib/nav/groups.ts`
- Modify: `components/pipeline/DataReadinessDashboard.tsx`
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`
- Modify: `package.json`

**Interfaces:**
- Consumes the APIs from Task 6.
- Provides interest/exclude actions but no automatic downstream generation.

- [ ] **Step 1: Write structural UI tests**

Assert the page is role-gated, the client posts only to `/api/product-finder`, the form sends `mode: "stored_only"`, result cards render all five axes plus confidence/missing data, and no component references `/api/recommend`.

- [ ] **Step 2: Verify failure because the page is absent**

Run: `npx tsx scripts/test-product-finder-view.ts`

- [ ] **Step 3: Build the form and result cards**

The form includes category, target customer, price min/max, target margin, desired features, excluded terms, and result count. The submit button copy explicitly says it uses accumulated data. Result cards display source class badges (`確認済み`, `外部主張`, `代理指標`, `推論`, `社内入力`) and render unknown profitability as `判断資料不足` / `판단 자료 부족`.

- [ ] **Step 4: Add decision actions**

`Interested` and `Exclude` call only the decision route. Exclude requires a reason. Add a disabled `Create screenplay` affordance with copy explaining it becomes available in the grounded-screenplay phase; do not fake the connection.

- [ ] **Step 5: Add navigation and pipeline entry point**

Add `/analytics/product-finder` under the market group for member/admin roles. Add a CTA from the readiness dashboard without changing readiness calculations.

- [ ] **Step 6: Add locale parity and verify**

Add the complete `productFinder` namespace to Japanese and Korean messages.

Run: `npm run check:i18n && npm run test:product-finder-view && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add package.json app/'[locale]'/'(market)'/analytics/product-finder components/product-finder lib/nav/groups.ts components/pipeline/DataReadinessDashboard.tsx messages/ja.json messages/ko.json scripts/test-product-finder-view.ts
git commit -m "feat(product-finder): add evidence-based finder UI"
```

---

### Task 8: Product Finder End-to-End Gate

**Files:**
- Create: `scripts/e2e-product-finder-stored-only.ts`
- Modify: `package.json`
- Modify: `docs/user-guide-ko.md`
- Modify: `docs/user-guide-jp.md`

**Interfaces:**
- Produces a read-mostly E2E command that creates one disposable recommendation run and deletes only that run at cleanup.

- [ ] **Step 1: Implement external-network tripwire**

Patch `globalThis.fetch` inside the service test so any host other than the configured Supabase URL throws `unexpected external request`. Run a stored-only query in one evidence-rich category and one sparse category.

- [ ] **Step 2: Assert the full stored-only contract**

For each result assert: run completed, knowledge snapshot mode is `stored_only`, every displayed reason points to at least one snapshot item, unknown profit is null, source claims remain claims, and no two items share a rank.

- [ ] **Step 3: Add and run the E2E command**

Add `"e2e:product-finder-stored-only": "tsx --env-file=.env.local scripts/e2e-product-finder-stored-only.ts"`.

Run:

```bash
npm run test:product-finder-schema
npm run test:product-finder-request
npm run test:product-finder-candidates
npm run test:product-finder-ranking
npm run test:product-finder-run
npm run test:product-finder-routes
npm run test:product-finder-view
npm run e2e:product-finder-stored-only
npx tsc --noEmit
```

Expected: all PASS, and the E2E script prints `external_requests=0`.

- [ ] **Step 4: Document and commit**

Document what each axis means, why competitor revenue is unavailable, and how to interpret unknown profitability.

```bash
git add package.json scripts/e2e-product-finder-stored-only.ts docs/user-guide-ko.md docs/user-guide-jp.md
git commit -m "test(product-finder): verify stored-only recommendation flow"
```
