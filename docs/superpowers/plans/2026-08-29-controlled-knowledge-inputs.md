# Controlled Knowledge Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, auditable supplemental research and flexible Excel import so new information enters the same evidence ledger without weakening stored-only defaults.

**Architecture:** Supplemental research is a user-confirmed job over a fixed gap enum; it stores classified evidence and then re-ranks from the database. Excel upload is a staged import with private original storage, deterministic parsing, operator-confirmed column mapping, append-only internal evidence, and reversible activation. Both inputs reuse canonical products, evidence, and knowledge snapshots.

**Tech Stack:** Next.js 16, TypeScript, Supabase/Postgres/Storage, Zod, `xlsx`, existing Brave/Rakuten clients and upload magic-byte checks, React 19, next-intl.

**Spec:** `docs/superpowers/specs/2026-08-29-on-demand-data-intelligence-pipeline-design.md`

## Global Constraints

- Requires the intelligence foundation and stored-only product-finder plans.
- Stored-only remains the default; only the dedicated supplemental endpoint may call external search providers.
- The user chooses exact gap types before research starts.
- Search results are classified as verified facts, source claims, or proxies; they are never written as competitor actual revenue/units unless a direct official source says so.
- Supplemental failure leaves the prior recommendation result intact.
- Excel product information alone is valid; performance/cost columns are optional.
- Blank numeric cells become unknown, while an explicit numeric zero remains zero.
- Imported evidence is append-only; rollback revokes it for future use without deleting audit history.

---

## File Map

- `supabase/migrations/20260829160000_controlled_knowledge_inputs.sql` — supplemental jobs, supplemented run mode, evidence revocation/import linkage.
- `supabase/migrations/20260829161000_intelligence_import_storage.sql` — private import bucket and owner policies.
- `lib/intelligence/supplement/types.ts` — allowed gaps and provider/result contracts.
- `lib/intelligence/supplement/providers.ts` — Brave/Rakuten adapter boundary.
- `lib/intelligence/supplement/run.ts` — explicit research, evidence persistence, and re-rank.
- `app/api/product-finder/runs/[id]/supplement/route.ts` — only external-research entry.
- `lib/intelligence/imports/types.ts` — column map and normalized row contracts.
- `lib/intelligence/imports/workbook.ts` — deterministic workbook parsing and validation.
- `lib/intelligence/imports/apply.ts` — canonical link/evidence apply and rollback.
- `app/api/intelligence/imports/*` — upload, mapping, apply, rollback APIs.
- `components/product-finder/SupplementResearchDialog.tsx` and `components/intelligence-imports/*` — explicit operator UI.

---

### Task 1: Controlled Input Schema and Evidence Revocation

**Files:**
- Create: `supabase/migrations/20260829160000_controlled_knowledge_inputs.sql`
- Create: `scripts/test-controlled-input-schema.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `supplemental_research_runs`.
- Extends product recommendation mode to `stored_only | supplemented`.
- Adds `import_batch_id`, `revoked_at`, `revoked_by`, and `revocation_reason` to evidence.

- [ ] **Step 1: Write the failing schema test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const sql = readFileSync("supabase/migrations/20260829160000_controlled_knowledge_inputs.sql", "utf8").toLowerCase();
assert.ok(sql.includes("create table supplemental_research_runs"));
assert.ok(sql.includes("mode in ('stored_only','supplemented')"));
assert.ok(sql.includes("add column import_batch_id"));
assert.ok(sql.includes("add column revoked_at"));
assert.ok(sql.includes("requested_gaps"));
console.log("PASS: controlled input schema");
```

- [ ] **Step 2: Verify ENOENT failure**

Run: `npx tsx scripts/test-controlled-input-schema.ts`

- [ ] **Step 3: Create the migration**

```sql
alter table product_recommendation_runs
  drop constraint if exists product_recommendation_runs_mode_check;
alter table product_recommendation_runs
  add constraint product_recommendation_runs_mode_check
  check (mode in ('stored_only','supplemented'));

alter table evidence_items
  add column import_batch_id uuid references import_batches(id) on delete restrict,
  add column revoked_at timestamptz,
  add column revoked_by uuid references profiles(id) on delete set null,
  add column revocation_reason text;

create index evidence_active_subject_idx
  on evidence_items(subject_type, subject_id, predicate, observed_at desc)
  where revoked_at is null;

create table supplemental_research_runs (
  id uuid primary key default gen_random_uuid(),
  recommendation_run_id uuid not null references product_recommendation_runs(id) on delete restrict,
  canonical_product_id uuid not null references canonical_products(id) on delete restrict,
  created_by uuid not null references profiles(id) on delete restrict,
  requested_gaps text[] not null,
  status text not null check (status in ('queued','running','completed','partial','failed')),
  prior_knowledge_snapshot_id uuid not null references knowledge_snapshots(id) on delete restrict,
  result_knowledge_snapshot_id uuid references knowledge_snapshots(id) on delete restrict,
  result_recommendation_run_id uuid references product_recommendation_runs(id) on delete restrict,
  evidence_count integer not null default 0 check (evidence_count >= 0),
  error_code text,
  error_summary text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (cardinality(requested_gaps) > 0),
  check (requested_gaps <@ array['official_product_facts','current_price','seller_sales_claim','review_signal','ranking_signal']::text[])
);

create index supplemental_runs_owner_idx on supplemental_research_runs(created_by, created_at desc);
alter table supplemental_research_runs enable row level security;
create policy supplemental_runs_owner_read on supplemental_research_runs for select to authenticated using (created_by = auth.uid());
```

- [ ] **Step 4: Run checks and commit**

Add `"test:controlled-input-schema": "tsx scripts/test-controlled-input-schema.ts"`.

Run: `npm run test:controlled-input-schema && npm run test:migrations`

```bash
git add package.json scripts/test-controlled-input-schema.ts supabase/migrations/20260829160000_controlled_knowledge_inputs.sql
git commit -m "feat(intelligence): add controlled input audit schema"
```

---

### Task 2: Supplemental Research Contracts and Provider Boundary

**Files:**
- Create: `lib/intelligence/supplement/types.ts`
- Create: `lib/intelligence/supplement/providers.ts`
- Create: `lib/intelligence/supplement/safe-fetch.ts`
- Create: `scripts/test-supplemental-provider-contract.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `SupplementGap`, `SupplementRequest`, `SupplementObservation`, and `researchGap()`.
- External providers are inaccessible to the stored-only product-finder modules.

- [ ] **Step 1: Write contract/classification tests**

```ts
assert.deepEqual(parseSupplementRequest({ gaps: ["current_price", "review_signal"] }), { gaps: ["current_price", "review_signal"] });
assert.throws(() => parseSupplementRequest({ gaps: ["actual_competitor_revenue"] }));
assert.equal(classifyObservation({ sourceKind: "seller", metric: "claimed_units" }), "source_claim");
assert.equal(classifyObservation({ sourceKind: "marketplace", metric: "review_count" }), "proxy");
```

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-supplemental-provider-contract.ts`

- [ ] **Step 3: Define the fixed gap enum**

```ts
export type SupplementGap = "official_product_facts" | "current_price" | "seller_sales_claim" | "review_signal" | "ranking_signal";
export interface SupplementRequest { gaps: SupplementGap[] }
export interface SupplementObservation { gap: SupplementGap; predicate: string; value: unknown; unit?: string; evidenceClass: "verified" | "source_claim" | "proxy"; sourceType: "official_site" | "seller_page" | "rakuten" | "brave_result"; sourceUrl: string; sourceTitle: string; sourceLocator?: string; observedAt: string; confidence: number }
```

- [ ] **Step 4: Implement provider adapters**

`researchGap(product, gap, deps)` uses Rakuten only for price/review/ranking and Brave only to locate official/seller pages. It returns at most 10 observations per gap, rejects URLs without HTTP(S), stores no snippet longer than 1,000 characters, and times out each request at 5 seconds. `safeFetchSourcePage()` resolves DNS before each request and redirect, rejects loopback/private/link-local addresses, allows at most three redirects and 2 MB, and accepts only HTML/text. A fact may become `verified` only when read from the fetched official page; a Brave snippet alone remains a `source_claim` or `proxy`. Seller claims always remain `source_claim`.

```ts
export async function safeFetchSourcePage(url: string, options?: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number }): Promise<{ finalUrl: string; contentType: string; text: string }>;
export async function researchGap(product: { id: string; name: string; category: string | null }, gap: SupplementGap, deps: SupplementProviderDeps): Promise<SupplementObservation[]>;
```

- [ ] **Step 5: Add a static import-boundary test**

Read `lib/product-finder/candidates.ts`, `ranking.ts`, and `run.ts`; assert none import `lib/intelligence/supplement`, Brave, or Rakuten. Read `providers.ts`; assert external imports occur only there.

- [ ] **Step 6: Run and commit**

Add `"test:supplemental-provider-contract": "tsx scripts/test-supplemental-provider-contract.ts"`.

Run: `npm run test:supplemental-provider-contract && npx tsc --noEmit`

```bash
git add package.json lib/intelligence/supplement scripts/test-supplemental-provider-contract.ts
git commit -m "feat(intelligence): add explicit supplemental research providers"
```

---

### Task 3: Supplemental Research Run, Evidence Persistence, and Re-rank

**Files:**
- Create: `lib/intelligence/supplement/run.ts`
- Create: `app/api/product-finder/runs/[id]/supplement/route.ts`
- Create: `scripts/test-supplemental-research-run.ts`
- Modify: `lib/product-finder/types.ts`
- Modify: `lib/product-finder/run.ts`
- Modify: `lib/product-finder/candidates.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `runSupplementalResearch(sb, input)`.
- Generalizes the database-only rank stage to accept the snapshot mode while preserving the default POST parser as stored-only.

- [ ] **Step 1: Write orchestration failure/success tests**

Assert the service verifies run ownership, writes a running audit row, calls only selected gaps, persists observations as evidence, re-loads from the database, creates a `supplemented` recommendation run/snapshot, and leaves the original run unchanged. Provider failure for one gap yields `partial`; total failure returns the original run ID and no new recommendation run.

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-supplemental-research-run.ts`

- [ ] **Step 3: Implement the run service**

```ts
export async function runSupplementalResearch(
  sb: SupabaseClient,
  input: { recommendationRunId: string; canonicalProductId: string; userId: string; gaps: SupplementGap[] },
): Promise<{ supplementalRunId: string; status: "completed" | "partial" | "failed"; recommendationRunId: string; evidenceCount: number }>;
```

Convert observations through `buildEvidenceDraft()`. Use source URL plus predicate/value/observed date in dedupe keys. Re-rank with this exact database-only call; it performs no network calls:

```ts
await runProductFinderFromStoredEvidence(sb, input.userId, originalQuery, {
  mode: "supplemented",
});
```

Extend the runner option and `ProductFinderResult.mode` unions from `"stored_only"` to `"stored_only" | "supplemented"`; keep `parseProductFinderQuery()` restricted to stored-only.
Read `originalQuery` from the owned recommendation run and validate it again with `parseProductFinderQuery()` before passing it to the database-only runner.

- [ ] **Step 4: Exclude revoked evidence in every consumer**

Add `.is("revoked_at", null)` to active evidence queries. Add a test fixture proving rollback evidence is not assembled into a candidate.

- [ ] **Step 5: Implement the authenticated route**

The route requires member/admin, validates exact gaps, verifies the selected canonical product belongs to the owned run, and calls the service. Return 200 for completed/partial execution and 502 for total provider failure while including the original recommendation run ID.

- [ ] **Step 6: Run and commit**

Add `"test:supplemental-research-run": "tsx scripts/test-supplemental-research-run.ts"`.

Run: `npm run test:supplemental-research-run && npm run test:product-finder-candidates && npm run test:product-finder-run && npx tsc --noEmit`

```bash
git add package.json lib/intelligence/supplement/run.ts app/api/product-finder/runs/'[id]'/supplement/route.ts lib/product-finder scripts/test-supplemental-research-run.ts
git commit -m "feat(product-finder): add explicit gap research and rerank"
```

---

### Task 4: Explicit Additional-Research UI

**Files:**
- Create: `components/product-finder/SupplementResearchDialog.tsx`
- Create: `scripts/test-supplemental-research-view.ts`
- Modify: `components/product-finder/ProductFinderResultCard.tsx`
- Modify: `components/product-finder/ProductFinderClient.tsx`
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`
- Modify: `package.json`

**Interfaces:**
- Consumes Task 3 endpoint.
- Produces a new result view linked to, but never overwriting, the original run.

- [ ] **Step 1: Write structural confirmation tests**

Assert the dialog shows missing fields, checkboxes for only the five allowed gaps, a confirmation sentence that external search will run, and no request occurs on dialog open. Assert success navigates to the returned recommendation run.

- [ ] **Step 2: Verify component absence failure**

Run: `npx tsx scripts/test-supplemental-research-view.ts`

- [ ] **Step 3: Build the explicit dialog**

Preselect only gaps corresponding to the item's `missingData`. Require at least one checked gap and a second confirmation click. Display source-class rules before execution. Preserve the original card and show a link back after re-rank.

- [ ] **Step 4: Add locale parity and verify**

Run: `npm run check:i18n && npm run test:supplemental-research-view && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add package.json components/product-finder messages/ja.json messages/ko.json scripts/test-supplemental-research-view.ts
git commit -m "feat(product-finder): add explicit additional research UI"
```

---

### Task 5: Private Import Storage

**Files:**
- Create: `supabase/migrations/20260829161000_intelligence_import_storage.sql`
- Create: `scripts/test-intelligence-import-storage.ts`
- Modify: `package.json`

**Interfaces:**
- Produces private `intelligence-imports` bucket with owner-scoped authenticated access and service-role processing.

- [ ] **Step 1: Write the failing storage migration test**

Assert the migration creates the bucket with `public=false`, 15 MB limit, XLS/XLSX MIME types, and owner-folder policies using the first path segment.

- [ ] **Step 2: Verify ENOENT failure**

Run: `npx tsx scripts/test-intelligence-import-storage.ts`

- [ ] **Step 3: Create bucket and policies**

Insert bucket ID/name `intelligence-imports`, set `file_size_limit=15728640`, and allow only Excel MIME types. Storage paths must be `${auth.uid()}/${batchId}/${safeFileName}`. Authenticated users can read/delete only their first-folder objects; uploads occur through the server route with service credentials.

- [ ] **Step 4: Run and commit**

Add `"test:intelligence-import-storage": "tsx scripts/test-intelligence-import-storage.ts"`.

Run: `npm run test:intelligence-import-storage && npm run test:migrations`

```bash
git add package.json scripts/test-intelligence-import-storage.ts supabase/migrations/20260829161000_intelligence_import_storage.sql
git commit -m "feat(imports): add private intelligence import storage"
```

---

### Task 6: Deterministic Workbook Parser and Column Mapping

**Files:**
- Create: `lib/intelligence/imports/types.ts`
- Create: `lib/intelligence/imports/workbook.ts`
- Create: `scripts/test-intelligence-workbook.ts`
- Create: `scripts/fixtures/intelligence-import/minimal-products.xlsx`
- Create: `scripts/fixtures/intelligence-import/products-with-performance.xlsx`
- Modify: `package.json`

**Interfaces:**
- Produces `parseWorkbook()`, `suggestColumnMapping()`, and `validateImportRows()`.
- No LLM is required for import correctness.

- [ ] **Step 1: Create fixtures and failing parser tests**

Minimal fixture contains product name/code/category only. Performance fixture includes explicit zero quantity, blank quantity, revenue, cost, fees, gross profit, and period. Assert zero stays 0 and blank stays null.

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-intelligence-workbook.ts`

- [ ] **Step 3: Define import contracts**

```ts
export type ImportField = "product_code" | "product_name" | "brand" | "model_name" | "category" | "description" | "list_price_jpy" | "sale_price_jpy" | "quantity" | "revenue_jpy" | "cost_jpy" | "fees_jpy" | "shipping_jpy" | "gross_profit_jpy" | "period_start" | "period_end";
export type ColumnMapping = Partial<Record<ImportField, string>>;
export interface ParsedWorkbook { sheetName: string; headers: string[]; rows: Array<{ rowNumber: number; cells: Record<string, unknown> }>; totalRows: number }
export interface NormalizedImportRow { rowNumber: number; productName: string; productCode: string | null; brand: string | null; modelName: string | null; category: string | null; description: string | null; metrics: Partial<Record<"list_price_jpy" | "sale_price_jpy" | "quantity" | "revenue_jpy" | "cost_jpy" | "fees_jpy" | "shipping_jpy" | "gross_profit_jpy", number | null>>; periodStart: string | null; periodEnd: string | null; errors: string[] }
```

- [ ] **Step 4: Implement deterministic parsing**

Read the first non-empty sheet by default, preserve row numbers, cap preview at 2,000 rows, normalize headers with NFKC/lowercase/whitespace collapse, and match Japanese/Korean/English aliases. `product_name` is the only required mapped field. Parse currencies by removing commas, yen symbols, and spaces; reject non-finite and negative cost/revenue values; treat empty cells as null.

- [ ] **Step 5: Run and commit**

Add `"test:intelligence-workbook": "tsx scripts/test-intelligence-workbook.ts"`.

Run: `npm run test:intelligence-workbook && npx tsc --noEmit`

```bash
git add package.json lib/intelligence/imports scripts/fixtures/intelligence-import scripts/test-intelligence-workbook.ts
git commit -m "feat(imports): parse flexible product workbooks"
```

---

### Task 7: Upload, Preview, Mapping, and Validation APIs

**Files:**
- Create: `app/api/intelligence/imports/route.ts`
- Create: `app/api/intelligence/imports/[id]/mapping/route.ts`
- Create: `app/api/intelligence/imports/[id]/route.ts`
- Create: `scripts/test-intelligence-import-routes.ts`
- Modify: `package.json`

**Interfaces:**
- POST upload returns batch, suggested mapping, headers, sample rows, and validation summary.
- PATCH mapping stores a confirmed mapping and normalized row errors.
- GET returns only the owner's batch.

- [ ] **Step 1: Write static auth/size/content tests**

Assert every route uses `requireUser`, upload accepts only one XLS/XLSX file, reuses `checkMagicBytes`, caps at 15 MB, computes SHA-256, stores a private path, and creates `import_rows` before returning preview.

- [ ] **Step 2: Verify absent-route failure**

Run: `npx tsx scripts/test-intelligence-import-routes.ts`

- [ ] **Step 3: Implement upload and preview**

Create batch status `uploaded`, storage path `${userId}/${batchId}/${safeName}`, parse workbook, insert raw rows, and return at most 20 samples. Duplicate file hashes create a new batch but return a warning with prior batch IDs; do not silently reuse or reject.

- [ ] **Step 4: Implement mapping validation**

PATCH accepts a strict `ColumnMapping`, verifies every source header exists, requires `product_name`, normalizes every row, stores `normalized_json` and errors, updates status to `validated` if at least one valid row exists or `failed` otherwise, and returns counts.

- [ ] **Step 5: Run and commit**

Add `"test:intelligence-import-routes": "tsx scripts/test-intelligence-import-routes.ts"`.

Run: `npm run test:intelligence-import-routes && npm run test:magic-bytes && npx tsc --noEmit`

```bash
git add package.json app/api/intelligence/imports scripts/test-intelligence-import-routes.ts
git commit -m "feat(imports): add upload mapping and validation APIs"
```

---

### Task 8: Apply and Roll Back Imported Evidence

**Files:**
- Create: `lib/intelligence/imports/apply.ts`
- Create: `app/api/intelligence/imports/[id]/apply/route.ts`
- Create: `app/api/intelligence/imports/[id]/rollback/route.ts`
- Create: `scripts/test-intelligence-import-apply.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `applyImportBatch(sb, batchId, userId)` and `rollbackImportBatch(sb, batchId, userId, reason)`.

- [ ] **Step 1: Write apply/rollback tests**

Assert valid rows create/reuse canonical products and `internal_excel` source links, product fields become `internal_input` evidence, performance metrics are emitted only when non-null, explicit zero is emitted as known zero, and rollback sets revocation fields without deleting evidence or snapshots.

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-intelligence-import-apply.ts`

- [ ] **Step 3: Implement apply**

```ts
export async function applyImportBatch(sb: SupabaseClient, batchId: string, userId: string): Promise<{ appliedRows: number; failedRows: number; evidenceItems: number }>;
```

Require owner and status `validated`. Exact product code/source link wins; otherwise propose normalized name match only when unique and confidence is at least 0.95; ambiguous rows remain failed for review. Use `import_batch_id` on every evidence row. Status becomes `applied` or `partial`.

- [ ] **Step 4: Implement rollback**

```ts
export async function rollbackImportBatch(sb: SupabaseClient, batchId: string, userId: string, reason: string): Promise<{ revokedEvidence: number }>;
```

Require owner and status `applied|partial`, reason length 3–500, set `revoked_at/by/reason` on active evidence for the batch, and set batch status `rolled_back`. Do not delete canonical products or source links; mark orphaned, unconfirmed source links for later cleanup only when no active evidence remains.

- [ ] **Step 5: Add routes, run, and commit**

Both POST routes validate ownership and return conflict for invalid state transitions.

Add `"test:intelligence-import-apply": "tsx scripts/test-intelligence-import-apply.ts"`.

Run: `npm run test:intelligence-import-apply && npm run test:product-finder-candidates && npx tsc --noEmit`

```bash
git add package.json lib/intelligence/imports/apply.ts app/api/intelligence/imports/'[id]'/apply app/api/intelligence/imports/'[id]'/rollback scripts/test-intelligence-import-apply.ts
git commit -m "feat(imports): apply and revoke internal evidence"
```

---

### Task 9: Data Management UI

**Files:**
- Create: `app/[locale]/(market)/analytics/data-management/page.tsx`
- Create: `components/intelligence-imports/ImportUpload.tsx`
- Create: `components/intelligence-imports/ColumnMappingReview.tsx`
- Create: `components/intelligence-imports/ImportValidationTable.tsx`
- Create: `components/intelligence-imports/ImportBatchHistory.tsx`
- Create: `scripts/test-intelligence-import-view.ts`
- Modify: `lib/nav/groups.ts`
- Modify: `components/pipeline/DataReadinessDashboard.tsx`
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`
- Modify: `package.json`

**Interfaces:**
- Consumes Tasks 7–8 APIs.
- Requires explicit apply and rollback confirmations.

- [ ] **Step 1: Write structural workflow tests**

Assert the UI order is upload → mapping → validation → apply, apply is disabled while valid rows are zero, invalid rows show exact errors, performance columns are labeled optional, and rollback requires a reason.

- [ ] **Step 2: Verify component absence failure**

Run: `npx tsx scripts/test-intelligence-import-view.ts`

- [ ] **Step 3: Build staged UI**

Show original headers beside target-field selects, a 20-row preview, valid/invalid/unknown numeric counts, canonical match suggestions, and a confirmation summary. History displays file hash, owner, state, row counts, applied time, and rollback state.

- [ ] **Step 4: Add navigation and readiness CTA**

Add `/analytics/data-management` for member/admin and a dashboard CTA. Viewer roles may see import coverage metrics but not file names or upload controls.

- [ ] **Step 5: Add locale parity and verify**

Run: `npm run check:i18n && npm run test:intelligence-import-view && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add package.json app/'[locale]'/'(market)'/analytics/data-management components/intelligence-imports lib/nav/groups.ts components/pipeline/DataReadinessDashboard.tsx messages/ja.json messages/ko.json scripts/test-intelligence-import-view.ts
git commit -m "feat(imports): add controlled data management UI"
```

---

### Task 10: Controlled Inputs End-to-End Gates

**Files:**
- Create: `scripts/e2e-supplemental-research.ts`
- Create: `scripts/e2e-intelligence-import.ts`
- Modify: `package.json`
- Modify: `docs/user-guide-ko.md`
- Modify: `docs/user-guide-jp.md`

**Interfaces:**
- Produces separate E2E commands so supplemental research and Excel import can be released independently.

- [ ] **Step 1: Implement supplemental E2E**

Start from a stored-only recommendation with a known missing gap, request exactly one gap, assert only its provider is called, evidence is classified and persisted, a supplemented run/snapshot is created, and the original result is unchanged. Simulate provider failure and assert the original run remains usable.

- [ ] **Step 2: Implement Excel E2E**

Upload the minimal fixture, confirm mapping, validate, apply, verify product-finder sees internal product fields but unknown profit; upload the performance fixture, apply, verify explicit profit is available; rollback both and verify new queries exclude revoked evidence while historical snapshots still resolve.

- [ ] **Step 3: Add commands and run the complete gates**

Add:

```json
"e2e:supplemental-research": "tsx --env-file=.env.local scripts/e2e-supplemental-research.ts",
"e2e:intelligence-import": "tsx --env-file=.env.local scripts/e2e-intelligence-import.ts"
```

Run:

```bash
npm run test:controlled-input-schema
npm run test:supplemental-provider-contract
npm run test:supplemental-research-run
npm run test:supplemental-research-view
npm run test:intelligence-import-storage
npm run test:intelligence-workbook
npm run test:intelligence-import-routes
npm run test:intelligence-import-apply
npm run test:intelligence-import-view
npm run e2e:supplemental-research
npm run e2e:intelligence-import
npx tsc --noEmit
```

Expected: all PASS. Supplemental output lists requested and called gaps; import output lists applied/revoked evidence and proves blank/zero separation.

- [ ] **Step 4: Document and commit**

Document explicit research consent, evidence class labels, Excel minimum fields, optional metrics, mapping review, and rollback semantics.

```bash
git add package.json scripts/e2e-supplemental-research.ts scripts/e2e-intelligence-import.ts docs/user-guide-ko.md docs/user-guide-jp.md
git commit -m "test(intelligence): verify controlled knowledge inputs"
```
