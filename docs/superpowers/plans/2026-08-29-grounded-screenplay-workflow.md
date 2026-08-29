# Grounded Screenplay Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Screenplay entry point generate through one workflow that persists product facts, reference broadcasts, pattern status, outline, demo plan, knowledge snapshot, and claim grounding.

**Architecture:** Introduce a generation-context record between a Screenplay request and its version. Initial and refine runs both consume an immutable context; the current generator remains responsible for prose while new pre-generation services build facts, reference broadcasts, and a structured rundown. Existing compliance/remediation remains in the workflow and gains evidence-linked claim output.

**Tech Stack:** Next.js 16, TypeScript, Supabase, Workflow DevKit, Gemini, existing `lib/screenplay` and `lib/broadcast-intel`, React 19, next-intl.

**Spec:** `docs/superpowers/specs/2026-08-29-on-demand-data-intelligence-pipeline-design.md`

## Global Constraints

- Requires the intelligence foundation plan; product-finder integration additionally requires the stored-only product-finder plan.
- Recommendation-selected, existing Research, uploaded, and manually entered products all use the same workflow.
- Competitor broadcasts contribute structure and aggregate patterns, never unverified competitor product facts or copied phrases.
- Pattern absence is explicit: `disabled`, `no_category`, `off_whitelist`, `under_sampled`, `timed_out`, `failed`, or `applied`.
- Stored evidence is the default. This plan does not run supplemental web research.
- Major factual claims must link to evidence or be marked `[確認必要]` / `[확인 필요]`.
- Existing Screenplay versions remain readable; new provenance columns are nullable for legacy rows.

---

## File Map

- `supabase/migrations/20260829150000_screenplay_generation_context.sql` — generation contexts, version link, and claim links.
- `lib/screenplay/context/types.ts` — fact pack, reference, pattern result, outline, and demo plan contracts.
- `lib/screenplay/context/product-facts.ts` — stored/internal-input fact pack builder.
- `lib/screenplay/context/reference-broadcasts.ts` — similar analyzed-broadcast retrieval.
- `lib/screenplay/context/pattern-result.ts` — explicit pattern-status loader.
- `lib/screenplay/context/structure-plan.ts` — structured outline/demo plan generation.
- `lib/screenplay/context/build.ts` — one context orchestration service and knowledge snapshot.
- `lib/screenplay/start-generation.ts` — shared start service used by API and CLI.
- `lib/screenplay/grounding/claim-links.ts` — post-generation evidence mapping and competitor-copy checks.
- Existing workflow, prompt, route, CLI, types, and workspace components are modified at integration points.

---

### Task 1: Generation Context and Claim-Link Schema

**Files:**
- Create: `supabase/migrations/20260829150000_screenplay_generation_context.sql`
- Create: `scripts/test-screenplay-context-schema.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `screenplay_generation_contexts`, `screenplay_claim_links`, and nullable `screenplay_versions.generation_context_id`.

- [ ] **Step 1: Write the failing schema test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const sql = readFileSync("supabase/migrations/20260829150000_screenplay_generation_context.sql", "utf8").toLowerCase();
assert.ok(sql.includes("create table screenplay_generation_contexts"));
assert.ok(sql.includes("create table screenplay_claim_links"));
assert.ok(sql.includes("add column generation_context_id"));
assert.ok(sql.includes("pattern_status in ('disabled','no_category','off_whitelist','under_sampled','timed_out','failed','applied')"));
assert.ok(sql.includes("status in ('supported','source_claim','needs_review')"));
console.log("PASS: screenplay context schema");
```

- [ ] **Step 2: Verify ENOENT failure**

Run: `npx tsx scripts/test-screenplay-context-schema.ts`

- [ ] **Step 3: Create the additive migration**

```sql
create table screenplay_generation_contexts (
  id uuid primary key default gen_random_uuid(),
  screenplay_id uuid not null references screenplays(id) on delete cascade,
  run_id text not null,
  knowledge_snapshot_id uuid not null references knowledge_snapshots(id) on delete restrict,
  product_fact_pack jsonb not null,
  reference_broadcasts jsonb not null default '[]'::jsonb,
  pattern_status text not null check (pattern_status in ('disabled','no_category','off_whitelist','under_sampled','timed_out','failed','applied')),
  pattern_detail text,
  pattern_snapshot jsonb,
  outline jsonb not null,
  demo_plan jsonb not null,
  model_version text,
  created_at timestamptz not null default now(),
  unique (screenplay_id, run_id)
);

alter table screenplay_versions
  add column generation_context_id uuid references screenplay_generation_contexts(id) on delete restrict;

create table screenplay_claim_links (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references screenplay_versions(id) on delete cascade,
  line_start integer not null check (line_start > 0),
  line_end integer not null check (line_end >= line_start),
  claim_text text not null,
  status text not null check (status in ('supported','source_claim','needs_review')),
  evidence_item_id uuid references evidence_items(id) on delete restrict,
  reason text not null,
  created_at timestamptz not null default now(),
  check ((status = 'needs_review') = (evidence_item_id is null))
);

create index screenplay_context_screenplay_idx on screenplay_generation_contexts(screenplay_id, created_at desc);
create index screenplay_claim_links_version_idx on screenplay_claim_links(version_id, line_start);

alter table screenplay_generation_contexts enable row level security;
alter table screenplay_claim_links enable row level security;
create policy screenplay_generation_contexts_read on screenplay_generation_contexts for select to authenticated using (
  exists (select 1 from screenplays s where s.id = screenplay_id)
);
create policy screenplay_claim_links_read on screenplay_claim_links for select to authenticated using (
  exists (select 1 from screenplay_versions v join screenplays s on s.id = v.screenplay_id where v.id = version_id)
);
```

- [ ] **Step 4: Run schema checks and commit**

Add `"test:screenplay-context-schema": "tsx scripts/test-screenplay-context-schema.ts"`.

Run: `npm run test:screenplay-context-schema && npm run test:migrations`

```bash
git add package.json scripts/test-screenplay-context-schema.ts supabase/migrations/20260829150000_screenplay_generation_context.sql
git commit -m "feat(screenplay): add grounded generation context schema"
```

---

### Task 2: Product Fact Pack for Existing and Manual Products

**Files:**
- Create: `lib/screenplay/context/types.ts`
- Create: `lib/screenplay/context/product-facts.ts`
- Create: `scripts/test-screenplay-fact-pack.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `ProductFactPack`, `ProductFact`, and `buildProductFactPack(sb, input)`.
- Manual brief facts are persisted as `internal_input` evidence under subject type `internal_product` and the Screenplay ID.

- [ ] **Step 1: Write fact-classification tests**

```ts
assert.equal(pack.facts.find((x) => x.key === "name")?.evidenceClass, "internal_input");
assert.equal(pack.facts.find((x) => x.key === "seller_claim_units")?.usage, "attributed_only");
assert.equal(pack.missing.includes("guarantee"), true);
assert.equal(pack.facts.some((x) => x.value === undefined), false);
```

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-screenplay-fact-pack.ts`

- [ ] **Step 3: Define exact fact contracts**

```ts
export interface ProductFact {
  key: string;
  label: string;
  value: unknown;
  unit?: string;
  evidenceClass: "verified" | "source_claim" | "proxy" | "inferred" | "internal_input";
  usage: "direct" | "attributed_only" | "planning_only";
  evidenceItemIds: string[];
  sourceLabel: string;
  observedAt: string;
}
export interface ProductFactPack {
  subjectId: string;
  canonicalProductId: string | null;
  facts: ProductFact[];
  missing: string[];
  forbiddenClaims: string[];
  builtAt: string;
}
```

- [ ] **Step 4: Implement the builder**

Use stored evidence when `canonicalProductId` is present. For a manual `ProductBrief`, append `internal_input` evidence for name, description, category, price, bonuses, guarantee, and notes using the Screenplay ID as subject. Map `source_claim` to `attributed_only`, proxies/inferences to `planning_only`, and verified/internal inputs to `direct`. A missing brief field goes only into `missing` and never becomes an evidence row with value 0 or empty string.

Use this signature:

```ts
export async function buildProductFactPack(
  sb: SupabaseClient,
  input: { screenplayId: string; canonicalProductId: string | null; brief: ProductBrief; observedAt: string },
): Promise<ProductFactPack>;
```

- [ ] **Step 5: Run and commit**

Add `"test:screenplay-fact-pack": "tsx scripts/test-screenplay-fact-pack.ts"`.

Run: `npm run test:screenplay-fact-pack && npx tsc --noEmit`

```bash
git add package.json lib/screenplay/context scripts/test-screenplay-fact-pack.ts
git commit -m "feat(screenplay): build evidence-classified product facts"
```

---

### Task 3: Similar Broadcast References and Explicit Pattern State

**Files:**
- Create: `lib/screenplay/context/reference-broadcasts.ts`
- Create: `lib/screenplay/context/pattern-result.ts`
- Create: `scripts/test-screenplay-reference-broadcasts.ts`
- Modify: `lib/broadcast-intel/category-pattern.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `loadReferenceBroadcasts(sb, brief, limit)` and `loadPatternResult(category, options)`.
- Replaces null-only pattern semantics with an explicit `PatternLoadResult`.

- [ ] **Step 1: Write similarity and status tests**

Test that same category + near price + matching demo cue outranks same category alone. Test every pattern status: missing category, off whitelist, insufficient samples, timeout, disabled, failure, and applied.

```ts
assert.equal(rankReferenceBroadcasts(fixtures, brief)[0]?.broadcastId, "similar-demo-price");
assert.deepEqual(await loadPatternResult(null, deps), { status: "no_category", pattern: null, detail: "product category is missing" });
assert.equal((await loadPatternResult("家電", appliedDeps)).status, "applied");
```

- [ ] **Step 2: Verify tests fail against current null-only loader**

Run: `npx tsx scripts/test-screenplay-reference-broadcasts.ts`

- [ ] **Step 3: Implement reference ranking**

```ts
export interface ReferenceBroadcast {
  broadcastId: string;
  channel: "qvc" | "shopch";
  airDate: string;
  category: string;
  programTitle: string;
  similarity: number;
  matchedOn: string[];
  analysisId: string;
}
export async function loadReferenceBroadcasts(sb: SupabaseClient, brief: ProductBrief, limit?: number): Promise<ReferenceBroadcast[]>;
```

Read only analyzed broadcasts. Score category 0.45, normalized price-band overlap 0.20, selling-point overlap 0.20, required demo/objection overlap 0.15. Return at most 8 with at least two channels when both are available.

- [ ] **Step 4: Implement explicit pattern result**

```ts
export type PatternLoadStatus = "disabled" | "no_category" | "off_whitelist" | "under_sampled" | "timed_out" | "failed" | "applied";
export interface PatternLoadResult { status: PatternLoadStatus; pattern: CategoryPattern | null; detail: string }
export async function loadPatternResult(category: string | null, options?: { enabled?: boolean; timeoutMs?: number }): Promise<PatternLoadResult>;
```

Keep `loadCategoryPattern()` as a compatibility wrapper returning `result.pattern` until all callers migrate.

- [ ] **Step 5: Run broadcast regression and commit**

Add `"test:screenplay-reference-broadcasts": "tsx scripts/test-screenplay-reference-broadcasts.ts"`.

Run: `npm run test:screenplay-reference-broadcasts && npm run test:broadcast-intel`

```bash
git add package.json lib/screenplay/context/reference-broadcasts.ts lib/screenplay/context/pattern-result.ts lib/broadcast-intel/category-pattern.ts scripts/test-screenplay-reference-broadcasts.ts
git commit -m "feat(screenplay): retrieve references with explicit pattern state"
```

---

### Task 4: Persisted Rundown and Demo Plan

**Files:**
- Create: `lib/screenplay/context/structure-plan.ts`
- Create: `scripts/test-screenplay-structure-plan.ts`
- Modify: `lib/screenplay/context/types.ts`
- Modify: `lib/screenplay/types.ts`
- Modify: `lib/screenplay/prompt.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `ScreenplayStructurePlan`, `buildStructurePlan(input, generateJson)`, and `formatStructurePlanBlock(plan)`.
- Adds `structurePlanBlock?: string` to `GenerateInput`.

- [ ] **Step 1: Write structured-output tests**

Use an injected fake `generateJson` and assert runtime shares sum between 0.95 and 1.05, every required demo appears once, unsupported factual claims are absent, and a thin-pattern input still produces a valid generic plan with `basis: "generic"`.

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-screenplay-structure-plan.ts`

- [ ] **Step 3: Define the structure types**

```ts
export interface ScreenplayOutlineSection { id: string; title: string; purpose: string; runtimeShare: number; keyMessages: string[]; factKeys: string[]; patternBasis: string[] }
export interface DemoPlanItem { id: string; sectionId: string; title: string; hostAction: string; cameraCue: string; requiredFactKeys: string[]; safetyNote: string | null }
export interface ScreenplayStructurePlan { basis: "competitor_pattern" | "generic"; runtimeMinutes: number; sections: ScreenplayOutlineSection[]; demos: DemoPlanItem[] }
```

- [ ] **Step 4: Implement schema-validated plan generation**

The prompt includes only the fact pack, aggregate pattern, reference metadata, and customization. Parse with Zod, reject duplicate IDs, normalize runtime shares only when their sum is within 0.85–1.15, and otherwise fail generation with a structured error. The generic fallback is deterministic: opening 0.08, problem 0.15, product introduction 0.17, demos 0.30, objections 0.12, offer 0.12, closing 0.06.

- [ ] **Step 5: Inject the plan into the screenplay prompt**

Add a `## 確定済み放送構成` section. Instruct the model to preserve order/share and use only listed `factKeys` for factual statements. Do not place reference broadcast verbatim transcript text in the prompt.

- [ ] **Step 6: Run and commit**

Add `"test:screenplay-structure-plan": "tsx scripts/test-screenplay-structure-plan.ts"`.

Run: `npm run test:screenplay-structure-plan && npm run test:screenplay-prompt && npx tsc --noEmit`

```bash
git add package.json lib/screenplay/context/structure-plan.ts lib/screenplay/context/types.ts lib/screenplay/types.ts lib/screenplay/prompt.ts scripts/test-screenplay-structure-plan.ts
git commit -m "feat(screenplay): add persisted rundown and demo plan"
```

---

### Task 5: Build and Persist One Generation Context

**Files:**
- Create: `lib/screenplay/context/build.ts`
- Create: `scripts/test-screenplay-context-build.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes Tasks 2–4 and foundation `createKnowledgeSnapshot()`.
- Produces `buildScreenplayGenerationContext(sb, input): Promise<ScreenplayGenerationContext>`.

- [ ] **Step 1: Write orchestration tests**

Assert the builder loads facts, references, pattern, and structure once; creates a `consumer_type=screenplay`, `mode=stored_only` knowledge snapshot; includes all fact and reference evidence; inserts one generation context; and persists a non-applied pattern status rather than dropping it.

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-screenplay-context-build.ts`

- [ ] **Step 3: Implement the builder**

```ts
export interface ScreenplayGenerationContext {
  id: string;
  screenplayId: string;
  runId: string;
  knowledgeSnapshotId: string;
  productFactPack: ProductFactPack;
  referenceBroadcasts: ReferenceBroadcast[];
  patternResult: PatternLoadResult;
  structurePlan: ScreenplayStructurePlan;
  createdAt: string;
}
export async function buildScreenplayGenerationContext(
  sb: SupabaseClient,
  input: { screenplayId: string; runId: string; canonicalProductId: string | null; brief: ProductBrief; mode: "initial" | "refine" },
): Promise<ScreenplayGenerationContext>;
```

For refine mode, load the base version's generation context and reuse its knowledge snapshot, facts, references, and pattern unless the linked product/brief changed; structure plan is regenerated from feedback only after validation. For initial mode, create all artifacts and the snapshot. Persist the context before prose generation so a failed generation remains diagnosable.

- [ ] **Step 4: Run and commit**

Add `"test:screenplay-context-build": "tsx scripts/test-screenplay-context-build.ts"`.

Run: `npm run test:screenplay-context-build && npx tsc --noEmit`

```bash
git add package.json lib/screenplay/context/build.ts scripts/test-screenplay-context-build.ts
git commit -m "feat(screenplay): persist generation context before drafting"
```

---

### Task 6: Unified Workflow Entry and Version Persistence

**Files:**
- Create: `lib/screenplay/start-generation.ts`
- Create: `scripts/test-screenplay-unified-entry.ts`
- Modify: `app/api/screenplays/route.ts`
- Modify: `app/api/screenplays/[id]/refine/route.ts`
- Modify: `lib/workflows/screenplay.workflow.ts`
- Modify: `lib/screenplay/product-brief.ts`
- Modify: `scripts/complete-recommendation-flow.ts`
- Modify: `lib/screenplay/types.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `startScreenplayGeneration(input)` as the only non-import entry.
- Workflow persists `generation_context_id` on every generated version.

- [ ] **Step 1: Write a static chokepoint test**

Assert `generateScreenplay(` appears only in `lib/workflows/screenplay.workflow.ts`, generator tests, and `lib/screenplay/generator.ts`; API/CLI entry files import `startScreenplayGeneration` instead. Assert workflow calls `buildScreenplayGenerationContext` before `generateStep`.

- [ ] **Step 2: Verify current CLI direct-call failure**

Run: `npx tsx scripts/test-screenplay-unified-entry.ts`

Expected: FAIL because `complete-recommendation-flow.ts` directly calls `generateScreenplay`.

- [ ] **Step 3: Add the shared start service**

```ts
export async function startScreenplayGeneration(input: {
  screenplayId: string;
  mode: "initial" | "refine";
  productBrief: ProductBrief;
  canonicalProductId: string | null;
  feedback?: string;
  baseVersionId?: string;
}): Promise<{ runId: string }>;
```

The service validates refine/base-version invariants and calls Workflow DevKit `start()`. Import mode remains a faithful separate branch because it does not generate prose.

- [ ] **Step 4: Integrate generation context into the workflow**

Add `canonicalProductId` to `ScreenplayWorkflowInput`. Build context, derive compliance/pattern/structure blocks from it, then generate. Change `persistStep()` to accept `generationContextId` and insert it. Pattern snapshot is copied from context for backward-compatible UI.

- [ ] **Step 5: Migrate API and CLI callers**

The API keeps the existing `productId` path through `loadProductBriefForScreenplay()`, adds a strict `canonicalProductId + productBrief` path for product-finder items, and uses null canonical ID for manual input. `lib/screenplay/product-brief.ts` adds `loadCanonicalProductBriefForScreenplay()` that reads the canonical product and active evidence without external calls. The completion script starts and polls the same workflow instead of synchronously inserting a version.

- [ ] **Step 6: Run workflow regressions and commit**

Add `"test:screenplay-unified-entry": "tsx scripts/test-screenplay-unified-entry.ts"`.

Run: `npm run test:screenplay-unified-entry && npm run test:screenplay-prompt && npm run test:screenplay-product-brief && npx tsc --noEmit`

```bash
git add package.json lib/screenplay/start-generation.ts lib/workflows/screenplay.workflow.ts lib/screenplay/types.ts lib/screenplay/product-brief.ts app/api/screenplays/route.ts app/api/screenplays/'[id]'/refine/route.ts scripts/complete-recommendation-flow.ts scripts/test-screenplay-unified-entry.ts
git commit -m "refactor(screenplay): route generation through one workflow"
```

---

### Task 7: Claim Grounding and Competitor-Copy Guard

**Files:**
- Create: `lib/screenplay/grounding/claim-links.ts`
- Create: `lib/screenplay/grounding/copy-guard.ts`
- Create: `scripts/test-screenplay-claim-links.ts`
- Modify: `lib/workflows/screenplay.workflow.ts`
- Modify: `lib/screenplay/compliance/types.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `buildClaimLinks(markdown, factPack, classifyClaims)` and `findReferencePhraseOverlap(markdown, referencePhrases)`.

- [ ] **Step 1: Write grounding tests**

Assert a price claim links to its price evidence, an attributed seller claim receives `source_claim`, an unsupported efficacy statement becomes `needs_review`, and a 30-character normalized competitor phrase overlap is reported.

- [ ] **Step 2: Verify missing-module failure**

Run: `npx tsx scripts/test-screenplay-claim-links.ts`

- [ ] **Step 3: Implement claim mapping**

```ts
export interface ClaimLinkDraft { lineStart: number; lineEnd: number; claimText: string; status: "supported" | "source_claim" | "needs_review"; evidenceItemId: string | null; reason: string }
export interface ClaimClassifierInput { numberedLines: Array<{ line: number; text: string }>; facts: ProductFact[] }
export interface ClaimClassifierOutput { lineStart: number; lineEnd: number; claimText: string; factKey: string | null; status: "supported" | "source_claim" | "needs_review"; reason: string }
export type ClaimClassifier = (input: ClaimClassifierInput) => Promise<ClaimClassifierOutput[]>;
export async function buildClaimLinks(markdown: string, factPack: ProductFactPack, classifyClaims: ClaimClassifier): Promise<ClaimLinkDraft[]>;
```

The classifier receives numbered script lines and fact keys/values, not external search. Validate every returned line range and evidence ID. If classifier output omits a detected numeric/efficacy/superlative claim, append `needs_review`. Both `supported` and `source_claim` rows require an evidence ID; only `needs_review` may have null evidence.

- [ ] **Step 4: Implement the copy guard**

Load only stored selling-language phrases associated with the generation context's referenced analysis IDs. Normalize NFKC, whitespace, punctuation, and speaker labels. Flag exact overlaps of 30 or more Japanese characters, excluding product name, legally required notice, and common offer boilerplate. Store findings in the existing check result under a new `competitorCopy` field. Full transcripts are used only for the local overlap comparison and are never injected into the generation prompt.

- [ ] **Step 5: Persist claim links before ready status**

After remediation and version insert, build and insert claim links. A version may become ready only when every major claim is supported, attributed, or explicitly needs review. Claim-link persistence failure marks the Screenplay failed rather than silently shipping ungrounded copy.

- [ ] **Step 6: Run and commit**

Add `"test:screenplay-claim-links": "tsx scripts/test-screenplay-claim-links.ts"`.

Run: `npm run test:screenplay-claim-links && npm run test:screenplay-check && npx tsc --noEmit`

```bash
git add package.json lib/screenplay/grounding lib/workflows/screenplay.workflow.ts lib/screenplay/compliance/types.ts scripts/test-screenplay-claim-links.ts
git commit -m "feat(screenplay): ground claims and detect copied phrases"
```

---

### Task 8: Provenance, Outline, and Demo-Plan UI

**Files:**
- Create: `components/screenplay/GenerationContextPanel.tsx`
- Create: `components/screenplay/ClaimEvidencePanel.tsx`
- Create: `scripts/test-screenplay-context-view.ts`
- Modify: `app/api/screenplays/[id]/route.ts`
- Modify: `components/screenplay/ScreenplayNavigator.tsx`
- Modify: `components/screenplay/VersionProvenance.tsx`
- Modify: `components/screenplay/ScreenplayWorkspace.tsx`
- Modify: `components/product-finder/ProductFinderResultCard.tsx`
- Modify: `lib/screenplay/types.ts`
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`
- Modify: `package.json`

**Interfaces:**
- GET Screenplay returns selected version context and claim links.
- UI displays context without allowing silent regeneration.

- [ ] **Step 1: Write structural UI tests**

Assert VersionProvenance renders all pattern statuses, Navigator has tabs for facts/references/outline/demo/claims, and legacy versions render `generation context unavailable` rather than inventing an empty applied state.

- [ ] **Step 2: Verify failure against positive-only provenance UI**

Run: `npx tsx scripts/test-screenplay-context-view.ts`

- [ ] **Step 3: Extend the read API and types**

Return `generationContext` and `claimLinks` for each selected version. Scope context through `screenplay_id` and claim links through `version_id`. Add nullable types for legacy versions.

- [ ] **Step 4: Build provenance panels**

Display fact class/source/date, reference channel/date/matched reasons, explicit pattern status/detail/sample, section runtime shares, demo cues, and claim support. Clicking a claim jumps to its script line.

- [ ] **Step 5: Add product-finder handoff**

Enable the product-finder result's `Create screenplay` action. It posts the chosen canonical product ID and stored brief to `/api/screenplays`; it does not auto-run when the recommendation is created.

- [ ] **Step 6: Add locale parity and verify**

Run: `npm run check:i18n && npm run test:screenplay-context-view && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add package.json app/api/screenplays/'[id]'/route.ts components/screenplay lib/screenplay/types.ts components/product-finder/ProductFinderResultCard.tsx messages/ja.json messages/ko.json scripts/test-screenplay-context-view.ts
git commit -m "feat(screenplay): show generation context and claim evidence"
```

---

### Task 9: Grounded Screenplay End-to-End Gate

**Files:**
- Create: `scripts/e2e-grounded-screenplay.ts`
- Modify: `package.json`
- Modify: `docs/user-guide-ko.md`
- Modify: `docs/user-guide-jp.md`

**Interfaces:**
- Produces an E2E command covering product-finder, manual product, evidence-rich category, and sparse category paths.

- [ ] **Step 1: Implement four E2E cases**

Create Screenplays from: a recommended canonical product, an existing Research product, a manual brief, and a sparse-category product. Poll the Workflow run to terminal status and clean up only rows tagged by the script's run IDs.

- [ ] **Step 2: Assert grounded output**

Every ready version must have generation context, knowledge snapshot mode `stored_only`, explicit pattern status, outline, demo plan, and claim links covering all detected major claims. Applied patterns must have sample size at least `MIN_SAMPLES`; sparse categories must show a non-applied reason.

- [ ] **Step 3: Run the complete suite**

Add `"e2e:grounded-screenplay": "tsx --env-file=.env.local scripts/e2e-grounded-screenplay.ts"`.

Run:

```bash
npm run test:screenplay-context-schema
npm run test:screenplay-fact-pack
npm run test:screenplay-reference-broadcasts
npm run test:screenplay-structure-plan
npm run test:screenplay-context-build
npm run test:screenplay-unified-entry
npm run test:screenplay-claim-links
npm run test:screenplay-context-view
npm run test:broadcast-intel
npm run e2e:grounded-screenplay
npx tsc --noEmit
```

Expected: all commands exit 0. The E2E report lists the knowledge snapshot, pattern status, reference count, claim coverage, and check score for each case.

- [ ] **Step 4: Document and commit**

```bash
git add package.json scripts/e2e-grounded-screenplay.ts docs/user-guide-ko.md docs/user-guide-jp.md
git commit -m "test(screenplay): verify grounded generation end to end"
```
