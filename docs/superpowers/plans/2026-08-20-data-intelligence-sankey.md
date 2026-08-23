# Data Intelligence Sankey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary radial pipeline preview with an interactive, presentation-ready infographic that shows which competitor home-shopping inputs become which reusable datasets and what present/future work those datasets enable.

**Architecture:** Keep the translated header in an async Server Component and pass only plain localized graph data to a focused Client Component. A pure graph model owns stable node IDs, stage/status metadata, conceptual weights, and link invariants; Recharts Sankey renders the relationship graph while a selectable inspector explains example fields and downstream uses.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Recharts 3.8 Sankey, Tailwind CSS, shadcn/ui Badge, next-intl, `tsx` + `node:assert/strict` tests.

**Spec:** `docs/superpowers/plans/2026-08-20-data-intelligence-sankey.md#design-contract`

## Design Contract

- The visible story is exactly three stages: `수집 원천 → 생성 데이터 → 활용 결과`.
- Source nodes: product/price/offer facts, broadcast schedule, video/audio archive, channel/category metadata.
- Generated-data nodes: unified product master, price/offer history, broadcast/category signals, scene/demo index, selling-point/speech corpus.
- Outcome nodes: product discovery, sourcing/MD prioritization, product research, product-evidence script draft, competitor-pattern-enhanced script, demo/staging plan.
- Current links are solid emerald; planned links are dashed slate. The legend must use the same visual language.
- Link widths are conceptual contribution weights, never presented as measured sales, volume, conversion, or accuracy.
- Selecting a node reveals its status, description, example fields, and connected upstream/downstream items.
- Korean and Japanese UI contain no hard-coded English presentation labels.
- The full Sankey remains available at narrow widths through an explicit horizontal-scroll affordance; nothing is clipped at 320px.

## Global Constraints

- Preserve all unrelated dirty-worktree changes; do not commit, push, reset, or overwrite adjacent user work.
- Reuse the installed `recharts` dependency; do not add a second graph library.
- Keep the Server/Client boundary JSON-serializable and keep the client component synchronous.
- Do not imply unavailable competitor sales performance data. Use schedule frequency, offer history, category presence, archived media, and extracted content only.
- Treat video scene indexing, speech-pattern extraction, competitor-pattern script enrichment, and demo/staging generation as planned.
- Keep graph metadata in one pure module so UI and tests cannot drift.
- Meet keyboard selection, focus visibility, semantic labels, and a text summary for screen-reader users.

---

## Task 1: Pure graph model and invariants (TDD)

**Files:**
- Create: `scripts/test-data-intelligence-graph.ts`
- Create: `lib/pipeline/data-intelligence-graph.ts`

- [x] **Step 1: Write a failing behavior test**

  Test the real exported graph contract with literal expectations:

  - four sources, five generated datasets, and six outcomes;
  - stable `source → dataset → outcome` stage transitions only;
  - every generated dataset has at least one upstream source and one downstream outcome;
  - planned datasets cannot emit a current link;
  - every current link connects current nodes only;
  - every node includes at least two example-field keys;
  - Sankey index conversion preserves the first and last known edge endpoints.

- [x] **Step 2: Run the test and observe RED**

  Run: `npx tsx scripts/test-data-intelligence-graph.ts`

  Expected: failure because `lib/pipeline/data-intelligence-graph.ts` does not exist.

- [x] **Step 3: Implement the minimal pure model**

  Export:

  ```ts
  export type DataFlowStage = "source" | "dataset" | "outcome";
  export type DataFlowStatus = "current" | "planned";
  export interface DataFlowNodeDefinition { id: string; stage: DataFlowStage; status: DataFlowStatus; fieldKeys: readonly string[]; }
  export interface DataFlowLinkDefinition { source: string; target: string; value: number; status: DataFlowStatus; }
  export const DATA_FLOW_NODES: readonly DataFlowNodeDefinition[];
  export const DATA_FLOW_LINKS: readonly DataFlowLinkDefinition[];
  export function buildSankeyData(): { nodes: DataFlowNodeDefinition[]; links: Array<{ source: number; target: number; value: number; status: DataFlowStatus }> };
  export function getConnectedNodeIds(nodeId: string): { upstream: string[]; downstream: string[] };
  ```

  Use conceptual integer weights only to make the diagram readable.

- [x] **Step 4: Run the test and observe GREEN**

  Run: `npx tsx scripts/test-data-intelligence-graph.ts`

  Expected: `PASS: data intelligence graph model`.

---

## Task 2: Interactive Recharts Sankey

**Files:**
- Create: `components/pipeline/DataFlowSankey.tsx`

- [x] **Step 1: Define the serializable client contract**

  Add localized node/link props containing strings, arrays, numbers, and status/stage literals only. Default selection is the unified product master dataset.

- [x] **Step 2: Render the Sankey graph**

  Use `ResponsiveContainer` with `minWidth={0}` and `initialDimension={{ width: 1, height: 1 }}`. Render a minimum-width chart inside `overflow-x-auto`, three translated stage headings, custom colored node cards, solid current paths, and dashed planned paths. Label the width encoding as conceptual contribution rather than an actual metric.

- [x] **Step 3: Add selection and keyboard behavior**

  Each custom SVG node is focusable and responds to click, Enter, and Space. Selected state must be visible and announced through an accurate accessible label including stage and current/planned status.

- [x] **Step 4: Add the detail inspector**

  Render selected-node title, description, status badge, example fields, upstream inputs, and downstream uses. Use empty-state copy only when the selected source/outcome naturally has no upstream/downstream side.

- [x] **Step 5: Add narrow-screen affordance**

  Keep the graph on all viewport sizes, add a translated swipe/scroll hint below `md`, and ensure the scroll container—not the page—owns horizontal overflow.

---

## Task 3: Server wrapper, translations, and page integration

**Files:**
- Modify: `components/pipeline/DataIntelligenceFlow.tsx`
- Modify: `messages/ko.json`
- Modify: `messages/ja.json`
- Verify: `app/[locale]/(market)/analytics/pipeline/page.tsx`

- [x] **Step 1: Replace the temporary SVG implementation**

  Keep `DataIntelligenceFlow` as an async Server Component. Localize model nodes with `t.raw`, construct plain serialized client props, and render `DataFlowSankey` below the existing presentation header.

- [x] **Step 2: Make status and legend semantics exact**

  Translate the kicker, stage headings, inspector labels, concept-weight notice, scroll hint, status values, every node title/description, and each node's example fields in Korean and Japanese. Remove the previous hard-coded English kicker/channel abbreviations.

- [x] **Step 3: Preserve the page composition**

  Confirm the infographic remains between the pipeline page header and the existing selection Kanban, with no data-loading or authorization changes.

- [x] **Step 4: Verify i18n parity**

  Run: `npm run check:i18n`

  Expected: Korean and Japanese key sets match.

---

## Task 4: Verification and review

**Files:**
- Verify: all files changed by Tasks 1–3

- [x] **Step 1: Run scoped static checks**

  Run:

  ```bash
  npx eslint components/pipeline/DataIntelligenceFlow.tsx components/pipeline/DataFlowSankey.tsx lib/pipeline/data-intelligence-graph.ts scripts/test-data-intelligence-graph.ts 'app/[locale]/(market)/analytics/pipeline/page.tsx'
  npx tsc --noEmit
  npx tsx scripts/test-data-intelligence-graph.ts
  npm run check:i18n
  npm run test:recharts-responsive-container
  ```

- [x] **Step 2: Browser-verify the real protected page**

  Inspect Korean desktop and narrow layouts at 1280px, 768px, 390px, and 320px. Confirm: no page-level overflow, horizontal graph scroll is explicit, all three stages are reachable, selected details update, current/planned styles match the legend, dark/light contrast is readable, and the Kanban still renders below.

  Verification note: the available browser session redirected the protected route to login, so the exact component was rendered temporarily inside the real locale/application shell at a local auth-free preview route. The temporary route and proxy allowance were removed immediately after verification; protected-page placement was verified statically.

- [x] **Step 3: Run React quality review**

  Apply `vercel:react-best-practices` to the edited TSX components and correct relevant findings.

- [x] **Step 4: Request independent code review**

  Ask a reviewer subagent to compare the implementation with this plan, accessibility requirements, responsive behavior, and the previous clipping/connector review findings. Fix Critical and Important findings, then re-run the affected checks.

- [x] **Step 5: Review the final diff**

  Confirm only the plan, graph model/test, infographic components, and intended locale sections changed for this feature; report any pre-existing overlapping modifications separately.
