# Data Intelligence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the canonical-product, evidence, snapshot, run-health, and balanced broadcast-analysis foundation that all on-demand product and screenplay features consume.

**Architecture:** Keep existing source/domain tables as systems of record and add an append-only intelligence layer above them. Backfill only recent active products and already-analyzed broadcasts first, expose real readiness through a server-side loader, and keep the existing product-selection kanban as a separate operational surface.

**Tech Stack:** Next.js 16 App Router, TypeScript 5, Supabase Postgres/RLS, React 19, next-intl, `tsx` assertion tests, existing broadcast-intel queue.

**Spec:** `docs/superpowers/specs/2026-08-29-on-demand-data-intelligence-pipeline-design.md`

## Global Constraints

- Current source scope is QVC Japan, Shop Channel, and the already-connected OA sources only.
- Background jobs may collect, normalize, extract evidence, and refresh insights; they must not auto-create recommendations, Research reports, or Screenplays.
- Existing source tables remain intact; all migrations are additive and rollback-safe.
- `unknown` is never stored or scored as numeric zero.
- Every evidence and insight record keeps source provenance and observation time.
- `product_selections` remains an operational kanban and is not a pipeline-health gate.
- Start with recent active products and existing analyzed broadcasts; do not bulk-process the entire historical corpus.

---

## File Map

- `supabase/migrations/20260829130000_intelligence_identity_evidence.sql` — canonical products, source links, evidence ledger.
- `supabase/migrations/20260829131000_intelligence_snapshots_runs.sql` — insight/knowledge snapshots, pipeline runs, import batches.
- `lib/intelligence/types.ts` — cross-feature contracts with no server-only imports.
- `lib/intelligence/evidence.ts` — pure validation, dedupe-key, and evidence constructors.
- `lib/intelligence/repository.ts` — service-role persistence functions.
- `lib/intelligence/pipeline-run.ts` — normalized run lifecycle shared by core crons.
- `lib/intelligence/backfill.ts` — pure mappings from existing rows into intelligence records.
- `scripts/backfill-intelligence-foundation.ts` — bounded, resumable backfill command.
- `lib/intelligence/insights.ts` and `refresh-insights.ts` — evidence-backed incremental insights.
- `lib/intelligence/readiness.ts` — real data-readiness loader and health classification.
- `app/api/intelligence/status/route.ts` — authenticated readiness API.
- `components/pipeline/DataReadinessDashboard.tsx` — server-rendered readiness summary.
- `lib/broadcast-intel/priority.ts` — pure category-balanced queue ordering.
- Existing pipeline page, audio cron, package scripts, and `messages/{ja,ko}.json` are modified only at their integration points.

---

### Task 1: Canonical Product and Evidence Schema

**Files:**
- Create: `supabase/migrations/20260829130000_intelligence_identity_evidence.sql`
- Create: `scripts/test-intelligence-identity-schema.ts`
- Modify: `package.json`

**Interfaces:**
- Produces tables `canonical_products`, `product_source_links`, and `evidence_items`.
- Later tasks rely on `evidence_items.dedupe_key` for idempotent writes and on `product_source_links(source_type, source_table, source_record_id)` for exact source identity.

- [ ] **Step 1: Write the failing migration contract test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/20260829130000_intelligence_identity_evidence.sql",
  "utf8",
);
for (const token of [
  "create table canonical_products",
  "create table product_source_links",
  "create table evidence_items",
  "evidence_class in ('verified','source_claim','proxy','inferred','internal_input')",
  "value_state in ('known','unknown','not_applicable','stale','conflicting')",
  "unique (source_type, source_table, source_record_id)",
  "unique (dedupe_key)",
  "enable row level security",
]) assert.ok(sql.toLowerCase().includes(token), `missing: ${token}`);
console.log("PASS: intelligence identity schema");
```

- [ ] **Step 2: Run the test and verify it fails because the migration does not exist**

Run: `npx tsx scripts/test-intelligence-identity-schema.ts`

Expected: FAIL with `ENOENT` for `20260829130000_intelligence_identity_evidence.sql`.

- [ ] **Step 3: Add the additive schema**

Create the migration with these exact columns and constraints:

```sql
create table canonical_products (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) > 0),
  brand text,
  model_name text,
  normalized_category text,
  attributes jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','merged','inactive')),
  merged_into_id uuid references canonical_products(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'merged') = (merged_into_id is not null))
);

create table product_source_links (
  id uuid primary key default gen_random_uuid(),
  canonical_product_id uuid not null references canonical_products(id) on delete cascade,
  source_type text not null check (source_type in ('qvc','shopch','oa','discovery','research','internal_excel')),
  source_table text not null,
  source_record_id text not null,
  source_product_id text,
  raw_name text not null,
  match_method text not null check (match_method in ('exact_id','normalized_key','similarity','manual')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  confirmed boolean not null default false,
  confirmed_by uuid references profiles(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, source_table, source_record_id),
  check (not confirmed or confirmed_at is not null)
);

create table evidence_items (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('product','broadcast','category','internal_product')),
  subject_id text not null,
  predicate text not null,
  value_json jsonb,
  unit text,
  value_state text not null default 'known'
    check (value_state in ('known','unknown','not_applicable','stale','conflicting')),
  evidence_class text not null
    check (evidence_class in ('verified','source_claim','proxy','inferred','internal_input')),
  source_type text not null,
  source_table text not null,
  source_record_id text not null,
  source_url text,
  source_locator text,
  observed_at timestamptz not null,
  valid_from timestamptz,
  valid_until timestamptz,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  raw_hash text,
  conflict_group text,
  supersedes_id uuid references evidence_items(id) on delete set null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (dedupe_key),
  check ((value_state = 'known') = (value_json is not null)),
  check (valid_until is null or valid_from is null or valid_until >= valid_from)
);

create index canonical_products_category_idx on canonical_products(normalized_category) where status = 'active';
create index product_source_links_product_idx on product_source_links(canonical_product_id);
create index evidence_subject_idx on evidence_items(subject_type, subject_id, predicate, observed_at desc);
create index evidence_source_idx on evidence_items(source_type, source_table, source_record_id);
create index evidence_fresh_idx on evidence_items(valid_until) where value_state = 'known';

alter table canonical_products enable row level security;
alter table product_source_links enable row level security;
alter table evidence_items enable row level security;

create policy canonical_products_read on canonical_products for select to authenticated using (true);
create policy product_source_links_read on product_source_links for select to authenticated using (true);
create policy evidence_items_read on evidence_items for select to authenticated using (true);
```

- [ ] **Step 4: Add and run the schema test command**

Add `"test:intelligence-identity-schema": "tsx scripts/test-intelligence-identity-schema.ts"` to `package.json`.

Run: `npm run test:intelligence-identity-schema`

Expected: `PASS: intelligence identity schema`.

- [ ] **Step 5: Validate all migrations and commit**

Run: `npm run test:migrations`

Expected: migration checker exits 0.

```bash
git add package.json scripts/test-intelligence-identity-schema.ts supabase/migrations/20260829130000_intelligence_identity_evidence.sql
git commit -m "feat(intelligence): add canonical product evidence schema"
```

---

### Task 2: Snapshot, Pipeline Run, and Import-Batch Schema

**Files:**
- Create: `supabase/migrations/20260829131000_intelligence_snapshots_runs.sql`
- Create: `scripts/test-intelligence-snapshot-schema.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `insight_snapshots`, `insight_snapshot_evidence`, `knowledge_snapshots`, `knowledge_snapshot_items`, `data_pipeline_runs`, `import_batches`, and `import_rows`.
- `knowledge_snapshots.mode` is the database enforcement point for `stored_only` versus `supplemented`.

- [ ] **Step 1: Write the failing schema test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const sql = readFileSync("supabase/migrations/20260829131000_intelligence_snapshots_runs.sql", "utf8").toLowerCase();
for (const table of ["insight_snapshots", "knowledge_snapshots", "knowledge_snapshot_items", "data_pipeline_runs", "import_batches", "import_rows"]) {
  assert.ok(sql.includes(`create table ${table}`), `missing ${table}`);
}
assert.ok(sql.includes("mode in ('stored_only','supplemented')"));
assert.ok(sql.includes("status in ('queued','running','succeeded','partial','failed')"));
assert.ok(sql.includes("num_nonnulls(evidence_item_id, insight_snapshot_id) = 1"));
console.log("PASS: intelligence snapshot schema");
```

- [ ] **Step 2: Verify the test fails with ENOENT**

Run: `npx tsx scripts/test-intelligence-snapshot-schema.ts`

Expected: FAIL because the migration is absent.

- [ ] **Step 3: Create the snapshot and run tables**

The migration must define:

```sql
create table insight_snapshots (
  id uuid primary key default gen_random_uuid(),
  insight_type text not null,
  subject_type text not null,
  subject_id text not null,
  input_from timestamptz,
  input_until timestamptz not null,
  result jsonb not null,
  evidence_count integer not null check (evidence_count >= 0),
  coverage jsonb not null default '{}'::jsonb,
  formula_version text not null,
  model_version text,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  valid_until timestamptz,
  created_at timestamptz not null default now()
);

create table insight_snapshot_evidence (
  insight_snapshot_id uuid not null references insight_snapshots(id) on delete cascade,
  evidence_item_id uuid not null references evidence_items(id) on delete restrict,
  primary key (insight_snapshot_id, evidence_item_id)
);

create table knowledge_snapshots (
  id uuid primary key default gen_random_uuid(),
  consumer_type text not null check (consumer_type in ('product_recommendation','research','screenplay')),
  consumer_run_id text not null,
  created_by uuid references profiles(id) on delete set null,
  mode text not null check (mode in ('stored_only','supplemented')),
  query_json jsonb not null default '{}'::jsonb,
  data_cutoff timestamptz not null,
  algorithm_version text not null,
  model_version text,
  created_at timestamptz not null default now(),
  unique (consumer_type, consumer_run_id)
);

create table knowledge_snapshot_items (
  id uuid primary key default gen_random_uuid(),
  knowledge_snapshot_id uuid not null references knowledge_snapshots(id) on delete cascade,
  evidence_item_id uuid references evidence_items(id) on delete restrict,
  insight_snapshot_id uuid references insight_snapshots(id) on delete restrict,
  usage_role text not null,
  result_locator text,
  created_at timestamptz not null default now(),
  check (num_nonnulls(evidence_item_id, insight_snapshot_id) = 1)
);

create table data_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  job_type text not null,
  external_run_id text,
  status text not null check (status in ('queued','running','succeeded','partial','failed')),
  cursor_json jsonb,
  target_scope jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{"new":0,"updated":0,"duplicate":0,"failed":0}'::jsonb,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_summary text,
  unique (source_type, job_type, external_run_id)
);

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references profiles(id) on delete restrict,
  file_name text not null,
  storage_path text not null,
  file_sha256 text not null,
  status text not null check (status in ('uploaded','mapped','validated','applied','partial','rolled_back','failed')),
  column_mapping jsonb,
  row_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw_json jsonb not null,
  normalized_json jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  canonical_product_id uuid references canonical_products(id) on delete set null,
  applied_at timestamptz,
  unique (import_batch_id, row_number)
);

create index insight_subject_idx on insight_snapshots(insight_type, subject_type, subject_id, input_until desc);
create index knowledge_consumer_idx on knowledge_snapshots(consumer_type, created_at desc);
create index pipeline_runs_latest_idx on data_pipeline_runs(source_type, job_type, started_at desc);
create index import_batches_owner_idx on import_batches(created_by, created_at desc);

alter table insight_snapshots enable row level security;
alter table insight_snapshot_evidence enable row level security;
alter table knowledge_snapshots enable row level security;
alter table knowledge_snapshot_items enable row level security;
alter table data_pipeline_runs enable row level security;
alter table import_batches enable row level security;
alter table import_rows enable row level security;

create policy insight_snapshots_read on insight_snapshots for select to authenticated using (true);
create policy insight_snapshot_evidence_read on insight_snapshot_evidence for select to authenticated using (true);
create policy knowledge_snapshots_read on knowledge_snapshots for select to authenticated using (created_by = auth.uid());
create policy knowledge_snapshot_items_read on knowledge_snapshot_items for select to authenticated using (
  exists (select 1 from knowledge_snapshots s where s.id = knowledge_snapshot_id and s.created_by = auth.uid())
);
create policy pipeline_runs_read on data_pipeline_runs for select to authenticated using (true);
create policy import_batches_owner_read on import_batches for select to authenticated using (created_by = auth.uid());
create policy import_rows_owner_read on import_rows for select to authenticated using (
  exists (select 1 from import_batches b where b.id = import_batch_id and b.created_by = auth.uid())
);
```

- [ ] **Step 4: Add the package script and run migration checks**

Add `"test:intelligence-snapshot-schema": "tsx scripts/test-intelligence-snapshot-schema.ts"`.

Run: `npm run test:intelligence-snapshot-schema && npm run test:migrations`

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/test-intelligence-snapshot-schema.ts supabase/migrations/20260829131000_intelligence_snapshots_runs.sql
git commit -m "feat(intelligence): add snapshot and run schemas"
```

---

### Task 3: Evidence Contracts and Idempotent Repository

**Files:**
- Create: `lib/intelligence/types.ts`
- Create: `lib/intelligence/evidence.ts`
- Create: `lib/intelligence/repository.ts`
- Create: `scripts/test-intelligence-evidence.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `EvidenceDraft`, `EvidenceItem`, `KnowledgeSnapshotDraft`, `buildEvidenceDraft()`, `evidenceDedupeKey()`, `upsertEvidence()`, and `createKnowledgeSnapshot()`.
- `buildEvidenceDraft()` rejects `valueState: "known"` without a value and rejects a non-known state with a value.

- [ ] **Step 1: Write tests for value-state honesty and stable dedupe keys**

```ts
import assert from "node:assert/strict";
import { buildEvidenceDraft, evidenceDedupeKey } from "../lib/intelligence/evidence";

const draft = buildEvidenceDraft({
  subjectType: "product",
  subjectId: "p1",
  predicate: "airing_count_30d",
  value: 12,
  valueState: "known",
  evidenceClass: "proxy",
  sourceType: "shopch",
  sourceTable: "broadcasts",
  sourceRecordId: "slot-1",
  observedAt: "2026-08-29T00:00:00.000Z",
  confidence: 0.9,
});
assert.equal(draft.value, 12);
assert.equal(evidenceDedupeKey(draft), evidenceDedupeKey(draft));
assert.throws(() => buildEvidenceDraft({ ...draft, value: undefined, valueState: "known" }));
assert.throws(() => buildEvidenceDraft({ ...draft, value: 0, valueState: "unknown" }));
console.log("PASS: intelligence evidence contracts");
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `npx tsx scripts/test-intelligence-evidence.ts`

Expected: FAIL resolving `lib/intelligence/evidence`.

- [ ] **Step 3: Define the shared contracts**

```ts
export type EvidenceClass = "verified" | "source_claim" | "proxy" | "inferred" | "internal_input";
export type EvidenceValueState = "known" | "unknown" | "not_applicable" | "stale" | "conflicting";
export type KnowledgeMode = "stored_only" | "supplemented";
export type SubjectType = "product" | "broadcast" | "category" | "internal_product";

export interface EvidenceDraft {
  subjectType: SubjectType;
  subjectId: string;
  predicate: string;
  value?: unknown;
  unit?: string;
  valueState: EvidenceValueState;
  evidenceClass: EvidenceClass;
  sourceType: string;
  sourceTable: string;
  sourceRecordId: string;
  sourceUrl?: string;
  sourceLocator?: string;
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  confidence: number;
  rawHash?: string;
}

export interface EvidenceItem extends EvidenceDraft {
  id: string;
  dedupeKey: string;
  revokedAt?: string;
}

export interface KnowledgeSnapshotDraft {
  consumerType: "product_recommendation" | "research" | "screenplay";
  consumerRunId: string;
  createdBy: string | null;
  mode: KnowledgeMode;
  query: Record<string, unknown>;
  dataCutoff: string;
  algorithmVersion: string;
  modelVersion?: string;
  items: Array<{ evidenceItemId?: string; insightSnapshotId?: string; usageRole: string; resultLocator?: string }>;
}
```

- [ ] **Step 4: Implement validation, SHA-256 dedupe, and repository functions**

`evidenceDedupeKey()` must hash a stable JSON object containing subject, predicate, source identity, observation time, state, and value. `upsertEvidence(sb, drafts)` maps camelCase to SQL columns and uses `.upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true })`. `createKnowledgeSnapshot(sb, draft)` inserts the parent, verifies each item has exactly one source ID, inserts child rows, and deletes the parent before throwing if child insertion fails.

Use these exact signatures:

```ts
export function buildEvidenceDraft(input: EvidenceDraft): EvidenceDraft;
export function evidenceDedupeKey(input: EvidenceDraft): string;
export async function upsertEvidence(sb: SupabaseClient, drafts: EvidenceDraft[]): Promise<string[]>;
export async function createKnowledgeSnapshot(sb: SupabaseClient, draft: KnowledgeSnapshotDraft): Promise<string>;
```

- [ ] **Step 5: Run focused and type checks**

Add `"test:intelligence-evidence": "tsx scripts/test-intelligence-evidence.ts"`.

Run: `npm run test:intelligence-evidence && npx tsc --noEmit`

Expected: PASS and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/intelligence scripts/test-intelligence-evidence.ts
git commit -m "feat(intelligence): add evidence contracts and repository"
```

---

### Task 4: Common Pipeline Run Recorder

**Files:**
- Create: `lib/intelligence/pipeline-run.ts`
- Create: `scripts/test-intelligence-pipeline-run.ts`
- Modify: `app/api/cron/daily-discovery-home/route.ts`
- Modify: `app/api/cron/daily-discovery-live/route.ts`
- Modify: `app/api/cron/daily-broadcasts/route.ts`
- Modify: `app/api/cron/daily-historical-broadcasts/route.ts`
- Modify: `app/api/cron/archive-videos/route.ts`
- Modify: `app/api/cron/analyze-broadcast-audio/route.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `startPipelineRun()` returning a handle with `heartbeat()`, `succeed()`, `partial()`, and `fail()`.
- Existing domain-specific run tables remain; this is a normalized operational mirror.

- [ ] **Step 1: Write state-transition and failure tests**

```ts
const handle = await startPipelineRun(fakeRepository, {
  sourceType: "qvc_shopch",
  jobType: "broadcast_schedule",
  externalRunId: "test-run",
  targetScope: { date: "2026-08-29" },
});
await handle.heartbeat({ processed: 3 });
await handle.succeed({ new: 2, updated: 1, duplicate: 0, failed: 0 });
assert.deepEqual(fakeRepository.states, ["running", "running", "succeeded"]);
await assert.rejects(() => handle.fail("late_failure", "cannot fail a terminal run"));
```

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-intelligence-pipeline-run.ts`

- [ ] **Step 3: Implement the recorder**

Use this exact API:

```ts
export interface PipelineRunCounts { new: number; updated: number; duplicate: number; failed: number; processed?: number }
export interface PipelineRunHandle {
  id: string;
  heartbeat(counts?: Partial<PipelineRunCounts>): Promise<void>;
  succeed(counts: PipelineRunCounts): Promise<void>;
  partial(counts: PipelineRunCounts, errorCode: string, summary: string): Promise<void>;
  fail(errorCode: string, summary: string): Promise<void>;
}
export interface PipelineRunRepository {
  insert(input: { sourceType: string; jobType: string; externalRunId: string; targetScope: Record<string, unknown> }): Promise<{ id: string }>;
  update(id: string, patch: Record<string, unknown>): Promise<void>;
}
export async function startPipelineRun(repository: PipelineRunRepository, input: { sourceType: string; jobType: string; externalRunId: string; targetScope: Record<string, unknown> }): Promise<PipelineRunHandle>;
```

Transitions are `running → succeeded|partial|failed` only. Error summaries are capped at 1,000 characters. Heartbeats merge count keys without turning missing values into zero.

- [ ] **Step 4: Dual-record the six core cron routes**

Start a normalized run after auth succeeds. Map each route's existing summary to common counts and preserve its original response/body. On caught failures, record `failed` before returning or throwing. Do not remove `discovery_runs` or `historical_crawl_runs`; their existing consumers continue to work during migration.

- [ ] **Step 5: Run cron regressions and commit**

Add `"test:intelligence-pipeline-run": "tsx scripts/test-intelligence-pipeline-run.ts"`.

Run: `npm run test:intelligence-pipeline-run && npm run test:pipeline-health && npm run test:discovery-cron-budget && npm run test:video-archive-deadline && npm run test:broadcast-intel`

```bash
git add package.json lib/intelligence/pipeline-run.ts scripts/test-intelligence-pipeline-run.ts app/api/cron/daily-discovery-home/route.ts app/api/cron/daily-discovery-live/route.ts app/api/cron/daily-broadcasts/route.ts app/api/cron/daily-historical-broadcasts/route.ts app/api/cron/archive-videos/route.ts app/api/cron/analyze-broadcast-audio/route.ts
git commit -m "feat(pipeline): record normalized source job runs"
```

---

### Task 5: Bounded Foundation Backfill

**Files:**
- Create: `lib/intelligence/backfill.ts`
- Create: `scripts/backfill-intelligence-foundation.ts`
- Create: `scripts/test-intelligence-backfill.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes `buildEvidenceDraft()` and `upsertEvidence()` from Task 3.
- Produces pure mappers `mapDiscoveredProductEvidence()` and `mapBroadcastAnalysisEvidence()` plus a CLI with `--since`, `--limit`, `--cursor`, and `--apply`.

- [ ] **Step 1: Write mapper tests**

Test one discovered product with `tv_evidence.airing_count=4` and one analyzed broadcast. Assert that price becomes `verified`, TV airing count becomes `proxy`, and an absent review count produces `valueState: "unknown"` with no numeric value.

```ts
assert.equal(productEvidence.find((x) => x.predicate === "price_jpy")?.evidenceClass, "verified");
assert.equal(productEvidence.find((x) => x.predicate === "tv_airing_count")?.evidenceClass, "proxy");
assert.equal(productEvidence.find((x) => x.predicate === "review_count")?.valueState, "unknown");
assert.equal(productEvidence.find((x) => x.predicate === "review_count")?.value, undefined);
```

- [ ] **Step 2: Verify the test fails because the mapper is absent**

Run: `npx tsx scripts/test-intelligence-backfill.ts`

Expected: module resolution failure.

- [ ] **Step 3: Implement pure row-to-evidence mappers**

Use exact signatures:

```ts
export function mapDiscoveredProductEvidence(row: DiscoveredProductBackfillRow): EvidenceDraft[];
export function mapBroadcastAnalysisEvidence(row: BroadcastAnalysisBackfillRow): EvidenceDraft[];
```

The product mapper emits name, normalized category, price, review count, TV airing count, and source URL. Before mapping a page, the CLI calls existing `normalizeCategoriesBatch()` for its distinct raw categories and passes the returned whitelist category to the mapper; an empty classification remains missing and is reported for review. The broadcast mapper emits air date, duration, segment pattern, selling points, evidence cues, objections, and offer timing. JSON arrays remain JSON values rather than flattened text.

- [ ] **Step 4: Implement the dry-run-first CLI**

The CLI defaults to `--limit=200`, refuses limits above 2,000, queries `discovered_products` updated since `--since` plus existing `broadcast_speech_analyses`, prints counts and the next cursor, and writes only when `--apply` is present. Every page calls the Task 3 repository and creates or reuses a source link before evidence insertion.

Run dry mode: `npx tsx --env-file=.env.local scripts/backfill-intelligence-foundation.ts --since=2026-06-01 --limit=20`

Expected: prints proposed canonical/source/evidence counts and `write=false`.

- [ ] **Step 5: Add tests and verify bounded live dry run**

Add `"test:intelligence-backfill": "tsx scripts/test-intelligence-backfill.ts"` and `"backfill:intelligence": "tsx --env-file=.env.local scripts/backfill-intelligence-foundation.ts"`.

Run: `npm run test:intelligence-backfill && npm run backfill:intelligence -- --since=2026-08-01 --limit=20`

Expected: unit PASS; dry run reads at most 20 rows per source and performs no writes.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/intelligence/backfill.ts scripts/backfill-intelligence-foundation.ts scripts/test-intelligence-backfill.ts
git commit -m "feat(intelligence): add bounded foundation backfill"
```

---

### Task 6: Incremental Evidence-to-Insight Refresh

**Files:**
- Create: `lib/intelligence/insights.ts`
- Create: `lib/intelligence/refresh-insights.ts`
- Create: `app/api/cron/refresh-intelligence-insights/route.ts`
- Create: `scripts/test-intelligence-insights.ts`
- Modify: `vercel.json`
- Modify: `package.json`

**Interfaces:**
- Consumes active `evidence_items` and produces versioned `insight_snapshots` plus complete `insight_snapshot_evidence` links.
- Produces `refreshIntelligenceInsights(sb, cutoff, limit)` for cron and local verification.

- [ ] **Step 1: Write product and category insight tests**

```ts
const product = buildProductMarketInsight(productEvidence, "2026-08-29T00:00:00.000Z");
assert.equal(product.result.demand.tvAirings30d, 4);
assert.equal(product.result.demand.actualCompetitorSales, undefined);
assert.deepEqual(product.evidenceIds.sort(), productEvidence.map((x) => x.id).sort());
assert.equal(product.coverage.profitability, "unknown");

const category = buildBroadcastCategoryInsight(broadcastEvidence, "家電", "2026-08-29T00:00:00.000Z");
assert.equal(category.result.sampleSize, 2);
assert.ok(category.confidence < 0.8, "a two-row sample must remain low confidence");
```

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-intelligence-insights.ts`

- [ ] **Step 3: Implement pure insight builders**

Use these exact signatures:

```ts
export interface InsightDraft {
  insightType: string;
  subjectType: "product" | "category";
  subjectId: string;
  inputFrom: string | null;
  inputUntil: string;
  result: Record<string, unknown>;
  evidenceIds: string[];
  coverage: Record<string, unknown>;
  formulaVersion: string;
  modelVersion?: string;
  confidence: number;
  validUntil?: string;
}
export function buildProductMarketInsight(evidence: EvidenceItem[], cutoff: string): InsightDraft;
export function buildBroadcastCategoryInsight(evidence: EvidenceItem[], category: string, cutoff: string): InsightDraft;
```

The product insight includes observed price range, TV airing proxies, review/ranking proxies, seller claims, internal profitability when present, and per-section coverage. The category insight includes product density, price distribution, analyzed sample count, channels, structure-pattern availability, and category imbalance. Both return every evidence ID actually used and no external-search fields.

- [ ] **Step 4: Implement bounded incremental refresh**

`refreshIntelligenceInsights()` selects subjects with active evidence newer than their latest insight cutoff, limits to 200 subjects per run, writes the snapshot and every evidence link, and records a normalized `data_pipeline_runs` row. A snapshot insert is rolled back if evidence-link count differs from `evidence_count`.

- [ ] **Step 5: Add authenticated cron and schedule**

Create a `CRON_SECRET`-protected GET route with `maxDuration=300`, `limit=200`, and a summary of product/category snapshots. Add the function duration and cron schedule `0 20 * * *` to `vercel.json`, after the 19:00 UTC broadcast-analysis run.

- [ ] **Step 6: Run and commit**

Add `"test:intelligence-insights": "tsx scripts/test-intelligence-insights.ts"`.

Run: `npm run test:intelligence-insights && npm run test:cron-duplicate-guard && npx tsc --noEmit`

```bash
git add package.json vercel.json lib/intelligence/insights.ts lib/intelligence/refresh-insights.ts app/api/cron/refresh-intelligence-insights/route.ts scripts/test-intelligence-insights.ts
git commit -m "feat(intelligence): refresh evidence-backed insights"
```

---

### Task 7: Real Pipeline Readiness Model and API

**Files:**
- Create: `lib/intelligence/readiness.ts`
- Create: `app/api/intelligence/status/route.ts`
- Create: `scripts/test-intelligence-readiness.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `loadIntelligenceReadiness(sb, now)` returning `IntelligenceReadiness`.
- The API is read-only and accessible to viewer/member/admin roles.

- [ ] **Step 1: Write the pure classification test**

```ts
const status = classifyReadiness({
  latestAttemptAt: "2026-08-29T00:00:00.000Z",
  latestSuccessAt: "2026-08-28T00:00:00.000Z",
  latestStatus: "failed",
  maxAgeMs: 26 * 3_600_000,
  nowMs: Date.parse("2026-08-29T01:00:00.000Z"),
});
assert.equal(status, "failed");
assert.equal(percent(0, 0), null);
assert.equal(percent(95, 100), 95);
```

- [ ] **Step 2: Run and verify the missing-module failure**

Run: `npx tsx scripts/test-intelligence-readiness.ts`

Expected: FAIL resolving `readiness`.

- [ ] **Step 3: Implement readiness contracts and loader**

Use these exact top-level fields:

```ts
export interface IntelligenceReadiness {
  generatedAt: string;
  sources: Array<{ key: string; latestAttemptAt: string | null; latestSuccessAt: string | null; status: "healthy" | "stale" | "failed" | "missing"; detail: string }>;
  coverage: {
    activeProducts: number;
    canonicalLinked: number;
    canonicalLinkPct: number | null;
    categorizedActive: number;
    categoryPct: number | null;
    archivedBroadcasts: number;
    analyzedBroadcasts: number;
    analysisPct: number | null;
    evidenceItems: number;
    insightSnapshots: number;
  };
  categorySamples: Array<{ category: string; total: number; analyzed: number; pct: number | null }>;
  failures: Array<{ sourceType: string; jobType: string; errorCode: string | null; errorSummary: string | null; startedAt: string }>;
}
```

Query `data_pipeline_runs` for attempts/failures, current domain tables for coverage, and the new intelligence tables for link/evidence counts. For the category gate, define `activeProducts` as products from the latest successful home/live Discovery runs plus canonical internal products with active source links; do not use the full historical archive as the denominator. Calculate percentages as `null` when the denominator is zero.

- [ ] **Step 4: Add authenticated API route**

`GET /api/intelligence/status` calls `requireUser(["viewer","member","admin"])`, then `loadIntelligenceReadiness(getServiceClient(), new Date())`, returns `Cache-Control: private, no-store`, and maps loader failures to `{ error: "intelligence_status_failed" }` with HTTP 500.

> **Correction (2026-08-30) — this step was wrong and has been reverted in code.** `getServiceClient()` bypasses RLS, and `/analytics/pipeline` is on the viewer allowlist, so following this step rendered member-only `broadcasts` / `discovered_products` / `broadcast_speech_analyses` aggregates to viewers. CLAUDE.md's rule — service-role is for cron and workflow steps only — stands; this plan is what gives way. Readiness now loads with `auth.sb`, and is skipped entirely for viewers because its sources are Group B. The route itself was deleted: it had no production consumer, and a second copy of the auth decision only drifts. The three remaining 2026-08-29 plans repeat this pattern; do not copy it.

- [ ] **Step 5: Run tests and an authenticated local API check**

Add `"test:intelligence-readiness": "tsx scripts/test-intelligence-readiness.ts"`.

Run: `npm run test:intelligence-readiness && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/intelligence/readiness.ts app/api/intelligence/status/route.ts scripts/test-intelligence-readiness.ts
git commit -m "feat(pipeline): expose real intelligence readiness"
```

---

### Task 8: Replace Static Pipeline Vision with Live Readiness

**Files:**
- Create: `components/pipeline/DataReadinessDashboard.tsx`
- Create: `scripts/test-pipeline-readiness-view.ts`
- Modify: `app/[locale]/(market)/analytics/pipeline/page.tsx`
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`
- Modify: `package.json`

**Interfaces:**
- Consumes `IntelligenceReadiness` from Task 7.
- Keeps `KanbanBoard` under a separately titled operational section.

- [ ] **Step 1: Write a structural view regression test**

Read the pipeline page as text and assert it imports `DataReadinessDashboard`, does not render `<DataIntelligenceFlow />`, still renders `<KanbanBoard`, and contains no condition that treats an empty board as failed readiness.

- [ ] **Step 2: Verify the test fails on the current static page**

Run: `npx tsx scripts/test-pipeline-readiness-view.ts`

Expected: FAIL because the page still renders `DataIntelligenceFlow`.

- [ ] **Step 3: Build the server component**

`DataReadinessDashboard` receives `IntelligenceReadiness` and renders:

- source cards with latest success and latest attempt;
- canonical-link, category, broadcast-analysis, evidence, and insight coverage;
- category sample table sorted by lowest analyzed percentage first;
- recent failures;
- explicit copy that zero recommendation/Screenplay runs is not a pipeline failure.

Use `null` to render `—`, never `0%`.

- [ ] **Step 4: Wire the page and preserve the kanban**

Load readiness in parallel with `loadBoard()`. Render readiness first and rename the second section using copy equivalent to `実際に取り扱うと決めた商品の運用` / `실제 취급을 결정한 상품 운영`. Do not change `product_selections` queries.

- [ ] **Step 5: Add matching Japanese and Korean keys**

Add the same key set under `pipeline.readiness` in both locale files: `title`, `description`, `sources`, `coverage`, `categories`, `failures`, `noFailures`, `notRequestedIsNormal`, and metric labels.

- [ ] **Step 6: Verify UI contracts**

Add `"test:pipeline-readiness-view": "tsx scripts/test-pipeline-readiness-view.ts"`.

Run: `npm run test:pipeline-readiness-view && npm run check:i18n && npx tsc --noEmit`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json app/'[locale]'/'(market)'/analytics/pipeline/page.tsx components/pipeline/DataReadinessDashboard.tsx messages/ja.json messages/ko.json scripts/test-pipeline-readiness-view.ts
git commit -m "feat(pipeline): show live data readiness"
```

---

### Task 9: Category-Balanced Broadcast Analysis Queue

**Files:**
- Create: `lib/broadcast-intel/priority.ts`
- Create: `scripts/test-broadcast-intel-priority.ts`
- Modify: `lib/broadcast-intel/queue.ts`
- Modify: `app/api/cron/analyze-broadcast-audio/route.ts`
- Modify: `scripts/drain-broadcast-analysis.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `chooseBalancedAnalysisSlots(rows, categoryCounts, limit)`.
- `seedAnalysisQueue()` accepts optional category for operator drains but the cron omits it and uses balanced ordering.

- [ ] **Step 1: Write the balancing test**

```ts
const picked = chooseBalancedAnalysisSlots(
  [
    { id: "a", category: "家電", airDate: "2026-08-29", repeatCount: 4 },
    { id: "b", category: "ファッション", airDate: "2026-08-28", repeatCount: 1 },
    { id: "c", category: "家電", airDate: "2026-08-27", repeatCount: 2 },
  ],
  new Map([["家電", 45], ["ファッション", 5]]),
  2,
);
assert.equal(picked[0]?.id, "b");
assert.equal(new Set(picked.map((x) => x.category)).size, 2);
```

- [ ] **Step 2: Verify the test fails because priority.ts is absent**

Run: `npx tsx scripts/test-broadcast-intel-priority.ts`

Expected: module resolution failure.

- [ ] **Step 3: Implement deterministic priority**

Use a tuple ordered by: current analyzed sample count ascending, repeat count descending, air date descending, ID ascending. Round-robin categories so one category cannot consume the whole batch when alternatives exist.

```ts
export interface AnalysisCandidate { id: string; category: string; airDate: string; repeatCount: number }
export function chooseBalancedAnalysisSlots(rows: AnalysisCandidate[], categoryCounts: ReadonlyMap<string, number>, limit: number): AnalysisCandidate[];
```

- [ ] **Step 4: Replace the cron's hard-coded category slice**

Remove `const SLICE_CATEGORY = process.env.BROADCAST_INTEL_CATEGORY || "家電"`. The cron calls the balanced seed path without a category. Preserve `--category` in the drain script as an explicit operator scope; when absent, use the balanced path.

- [ ] **Step 5: Run broadcast regression suite**

Add `"test:broadcast-intel-priority": "tsx scripts/test-broadcast-intel-priority.ts"`.

Run: `npm run test:broadcast-intel-priority && npm run test:broadcast-intel`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json lib/broadcast-intel/priority.ts lib/broadcast-intel/queue.ts app/api/cron/analyze-broadcast-audio/route.ts scripts/drain-broadcast-analysis.ts scripts/test-broadcast-intel-priority.ts
git commit -m "feat(broadcast-intel): balance analysis across categories"
```

---

### Task 10: Foundation Verification and Controlled Backfill

**Files:**
- Create: `scripts/verify-intelligence-foundation.ts`
- Modify: `package.json`
- Modify: `docs/user-guide-ko.md`
- Modify: `docs/user-guide-jp.md`

**Interfaces:**
- Produces a read-only verification command; no later task imports it.

- [ ] **Step 1: Add a failing verification-contract test to the script itself**

The script exits 1 unless all of these are true: migrations present, latest source attempt is visible, canonical links exist after apply, recent-active category coverage is at least 95%, evidence count is positive, every insight's `evidence_count` equals its link count, no known-state evidence has null value, and no non-known evidence has a value.

- [ ] **Step 2: Add the command and dry-run it before writes**

Add `"verify:intelligence-foundation": "tsx --env-file=.env.local scripts/verify-intelligence-foundation.ts"`.

Run: `npm run verify:intelligence-foundation`

Expected before backfill: exits 1 with explicit missing canonical/evidence counts, not a stack trace.

- [ ] **Step 3: Apply a bounded backfill**

Run: `npm run backfill:intelligence -- --since=2026-08-01 --limit=200 --apply`

Expected: prints inserted/reused counts and a next cursor; it does not exceed 200 source rows per source.

- [ ] **Step 4: Re-run all foundation gates**

Run:

```bash
npm run test:intelligence-identity-schema
npm run test:intelligence-snapshot-schema
npm run test:intelligence-evidence
npm run test:intelligence-backfill
npm run test:intelligence-pipeline-run
npm run test:intelligence-insights
npm run test:intelligence-readiness
npm run test:pipeline-readiness-view
npm run test:broadcast-intel
npm run test:broadcast-intel-priority
npm run verify:intelligence-foundation
npx tsc --noEmit
```

Expected: every command exits 0. The verifier prints actual category and analysis coverage without requiring any recommendation, Research, selection, or Screenplay row.

- [ ] **Step 5: Document operations and commit**

Document dry-run/apply, cursor resume, readiness meanings, and the fact that product outputs are on-demand.

```bash
git add package.json scripts/verify-intelligence-foundation.ts docs/user-guide-ko.md docs/user-guide-jp.md
git commit -m "docs(pipeline): add intelligence foundation operations"
```
