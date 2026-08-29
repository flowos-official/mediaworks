# Task 8 Report — Replace Static Pipeline Vision with Live Readiness

## Delivered

- Replaced the static `DataIntelligenceFlow` on the pipeline page with the server-rendered `DataReadinessDashboard`.
- Starts `loadBoard(auth.sb)` and `loadIntelligenceReadiness(getServiceClient(), new Date())` together, then awaits both with `Promise.all`.
- Retained every `product_selections` query and the existing client `KanbanBoard`; the operational section is now explicitly titled as products chosen for actual handling.
- Added matched `pipeline.readiness` Japanese/Korean copy for sources, statuses, metrics, tables, empty states, and the normal on-demand explanation.

## TDD evidence

1. Added `scripts/test-pipeline-readiness-view.ts` before changing production code.
2. Initial RED command: `npx tsx scripts/test-pipeline-readiness-view.ts` failed against the static page, which still imported and rendered `DataIntelligenceFlow`.
3. Regression mutation check: temporarily reintroducing `<DataIntelligenceFlow />` failed with `Pipeline page must not render the static DataIntelligenceFlow vision.` The temporary tag was removed immediately.
4. GREEN command: `npm run test:pipeline-readiness-view` passes. It inspects page wiring and server-renders representative readiness data, covering a null percentage dash, accessible failed status, deterministic category sorting, no-failures state, and normal on-demand copy.

## Verification outputs

- `npm run test:pipeline-readiness-view` — PASS: pipeline readiness page structure
- `npm run check:i18n` — OK — 1331 keys match
- `npx tsc --noEmit` — exit 0
- `git diff --check` — exit 0

## Files

- `app/[locale]/(market)/analytics/pipeline/page.tsx`
- `components/pipeline/DataReadinessDashboard.tsx`
- `messages/ja.json`
- `messages/ko.json`
- `package.json`
- `scripts/test-pipeline-readiness-view.ts`

## React checklist

- Page and readiness dashboard remain Server Components; the existing Kanban client boundary receives only its existing serializable board data.
- No hooks, effects, memoization, internal API fetch, or client date rendering were added.
- Independent board/readiness work runs in parallel; timestamps use explicit locale plus `Asia/Tokyo` time zone.
- Statuses contain visible and accessible text, tables use semantic headings and `scope`, long tables have responsive horizontal overflow, and list keys are deterministic.

## Concerns

No live loader call or server was started because the intelligence migrations remain unapplied. No environment files were changed.

## Round 1 Fix Evidence

### Root cause

- The category comparator classified only `null` as insufficient. `NaN`, `Infinity`, `-Infinity`, and runtime `undefined` reached subtraction; a `NaN` comparator result is treated as equality and skipped the deterministic tie-break.
- The percentage formatter handled only `null`, so non-finite values could render as `NaN%` or infinity text.
- `source.detail` and `failure.errorCode` existed in `IntelligenceReadiness` but were not rendered; the failure table selected only one error field.

### TDD evidence

1. Added the sort probe before changing the comparator. RED output: `AssertionError [ERR_ASSERTION]: Category sorting must put every insufficient percentage first, then finite percentages and deterministic category ties.`
2. Implemented a copied, finite-safe comparator. GREEN output: `PASS: pipeline readiness page structure`.
3. Added production-render assertions for identifiable metric values, non-finite category cells, source detail, both failure fields, and empty fallbacks. RED output: `AssertionError [ERR_ASSERTION]: Expected one rendered canonical-link coverage metric.` with `0 !== 1`.
4. Added the metric identifiers, finite-safe percentage formatter, source detail, separate error-code/summary cells, and localized copy. GREEN output: `PASS: pipeline readiness page structure`.

### Round 1 files

- `components/pipeline/DataReadinessDashboard.tsx`
- `messages/ja.json`
- `messages/ko.json`
- `scripts/test-pipeline-readiness-view.ts`

### Round 1 self-review

- The comparator copies its input, treats `null`, `undefined`, and every non-finite percentage as insufficient, sorts those first, then finite percentages, and breaks all ties with locale-independent string comparisons.
- Targeted rendered metric assertions prevent unrelated em dashes from satisfying null-coverage tests. The harness also verifies `NaN`, positive infinity, negative infinity, equal finite percentages, deterministic ties, and input-array nonmutation.
- All source/failure fields now have visible labels or cells and safe `—` fallbacks. Server-component boundaries, direct concurrent loaders, timestamps, Kanban queries, semantics, and responsive table overflow remain unchanged.

### Round 1 verification outputs

- `npm run test:pipeline-readiness-view` — `PASS: pipeline readiness page structure`
- `npm run check:i18n` — `OK — 1333 keys match`
- `npx tsc --noEmit` — exit 0
- `git diff --check` — exit 0
