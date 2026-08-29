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
