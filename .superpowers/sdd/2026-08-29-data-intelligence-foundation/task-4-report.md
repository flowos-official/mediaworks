# Task 4: Common Pipeline Run Recorder

## Status

Implemented and verified.

## Implementation

- Added `lib/intelligence/pipeline-run.ts` with the required `PipelineRunCounts`, `PipelineRunHandle`, `PipelineRunRepository`, and `startPipelineRun()` API.
- Added `createPipelineRunRepository()` as the small Supabase adapter for `data_pipeline_runs`. It inserts `running` rows and applies normalized update patches.
- Recorder state is `running` until one successful terminal update (`succeeded`, `partial`, or `failed`). Heartbeats merge only supplied count keys; terminal transitions and later heartbeats reject after completion; failure summaries are capped at 1,000 characters.
- Every normal recorder write is deliberately best-effort in routes: a normalized-write failure is logged and cannot replace an existing domain response/error.
- Existing domain run tables and responses remain in place. No recommendation, Research, Screenplay, queue-selection, or environment changes were made.

## TDD evidence

- RED: `npx tsx scripts/test-intelligence-pipeline-run.ts` initially failed with `Cannot find module '../lib/intelligence/pipeline-run'`.
- GREEN: after implementing the recorder, the focused script passed all lifecycle, merging, terminal-state, summary-cap, and repository-error assertions.

## Files changed

- `lib/intelligence/pipeline-run.ts`
- `scripts/test-intelligence-pipeline-run.ts`
- `package.json`
- `app/api/cron/daily-discovery-home/route.ts`
- `app/api/cron/daily-discovery-live/route.ts`
- `app/api/cron/daily-broadcasts/route.ts`
- `app/api/cron/daily-historical-broadcasts/route.ts`
- `app/api/cron/archive-videos/route.ts`
- `app/api/cron/analyze-broadcast-audio/route.ts`

## Route mapping and self-review

| Route | source/job | external ID | Counts and terminal mapping | Failure handling reviewed |
| --- | --- | --- | --- | --- |
| `daily-discovery-home` | `discovery` / `home_shopping` | existing `discovery_runs.id` | `new=produced`, `processed=produced`; partial for target miss or skipped optional stage | caught route failure records `discovery_failed` before existing `finalizeSession`/500 response |
| `daily-discovery-live` | `discovery` / `live_commerce` | existing `discovery_runs.id` | same as home discovery | caught route failure records `discovery_failed` before existing `finalizeSession`/500 response |
| `daily-broadcasts` | `qvc_shopch` / `broadcast_schedule` | UUID invocation | inserted/updated/source+enrichment errors/parsed slots; empty scrape is succeeded | thrown primary failure is recorded then rethrown; mirror failures are swallowed |
| `daily-historical-broadcasts` | `oa_channels` / `historical_broadcast_crawl` | existing `historical_crawl_runs.id` | upserted/skipped duplicate/persist+channel errors/rows, follows existing completed/partial/failed status | caught route failure records first, then keeps existing run finalization and 500 response |
| `archive-videos` | `qvc_shopch` / `video_archive` | UUID invocation | archived, queue/recovery updates, archive/preflight failures, processed slots; no work is succeeded | existing query-error response is unchanged; unexpected errors are recorded then rethrown; deadlines still dispose in `finally` |
| `analyze-broadcast-audio` | `broadcast_archive` / `audio_analysis` | UUID invocation | done, recovery/requeue updates, skipped, analysis+preflight failures, processed slots | existing query-error response is unchanged; unexpected errors are recorded then rethrown |

All recorders start only after cron authentication. Existing response bodies/statuses and source/domain tables were preserved; preflight errors that the original jobs intentionally continue past are reflected as normalized partial outcomes.

## Verification

Executed successfully:

`npm run test:intelligence-pipeline-run`
`npm run test:pipeline-health`
`npm run test:discovery-cron-budget`
`npm run test:video-archive-deadline`
`npm run test:broadcast-intel`
`npx tsc --noEmit`
`git diff --check`

## Concerns

No known blockers. The recorder is intentionally an operational mirror, so direct `data_pipeline_runs` database integration was not run; the task's required focused/relevant regressions and typecheck passed.
