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

---

## Review fix round 1/5

### Review findings addressed

- Changed the unshipped `data_pipeline_runs.counts` default from the invented numeric-zero object to `{}`. The Supabase adapter now explicitly inserts `{}`, and every terminal update writes the currently observed count object, including a fresh failure before any work.
- Added executable recorder contracts for adapter insert/fresh failure, known-count preservation before failure, discovery attempted-versus-saved counting, archive deferred/stale-abandoned partial outcomes, and audio seeded queue work.
- Discovery routes now record `processed=batch.length`, `new=savedCount`, and `duplicate=max(0, batch.length-savedCount)` without changing session behavior.
- Archive normalized outcomes now include `deferred` as unfinished/partial and include `stale_abandoned` in both failed and processed accounting.
- Audio normalized outcomes now include seeded queue entries in `new` and processed accounting; queue selection remains unchanged.
- Historical persistence now performs bounded (50-row) pre-upsert existence lookups, returns actual `inserted`/`updated` split counts, and the normalized historical route uses those values. Lookup failures are recorded as persistence errors and do not invent a split.
- Daily broadcasts and all-source historical failures heartbeat their known counts before their required public `fail()` call.

### TDD evidence

- RED: adapter/fresh-failure test failed with `undefined !== {}`; schema test failed because the migration still contained the numeric-zero default.
- GREEN: both passed after the migration and adapter/terminal count changes.
- RED: mapping contract failed because `pipeline-run-mapping` did not exist; historical persistence contract failed because `__test.splitRowsByExistingKeys` was absent.
- GREEN: mapping and historical persistence tests passed after the pure mapping module and bounded existence classification were implemented.

### Additional files changed

- `lib/intelligence/pipeline-run-mapping.ts`
- `lib/historical-crawl/persist.ts`
- `scripts/test-historical-crawl-persist.ts`
- `scripts/test-intelligence-snapshot-schema.ts`
- `supabase/migrations/20260829131000_intelligence_snapshots_runs.sql`

### Exact verification run

All commands exited 0:

`npm run test:intelligence-pipeline-run` — recorder lifecycle, adapter empty counts, failure count preservation, discovery/archive/audio mappings passed.
`npm run test:intelligence-snapshot-schema` — schema contract passed.
`npm run test:historical-persist` — inserted/updated conflict split passed.
`npm run test:pipeline-health` — passed.
`npm run test:discovery-cron-budget` — passed.
`npm run test:video-archive-deadline` — passed.
`npm run test:broadcast-intel` — all six component checks passed.
`npx tsc --noEmit` — passed.
`git diff --check` — passed.

### Review self-check

- The migration is unshipped and was edited in place as required; no environment file changed.
- Route HTTP bodies/statuses and existing discovery/historical run tables were not changed.
- The public `PipelineRunCounts` numeric fields and public recorder signatures are unchanged.
- The historical split is taken immediately before each upsert in bounded lookup requests. Concurrent writers between lookup and upsert remain a database race inherent to non-transactional client calls; the existing cron duplicate guard minimizes same-job overlap.

---

## Review fix round 2/5

### Findings addressed

- Replaced historical product-name `.or()` URL predicates with a compact, paginated lookup by bounded channel and air-date filters (31 dates/page, 1,000 returned rows/page). Product names are fetched in response bodies and classified locally, never placed in a query URL.
- Added injected persistence coverage proving a 500-character product name does not enter lookup filters. When classification is unavailable, the complete batch is truthfully counted as failed, with zero `upserted`/`inserted`/`updated`, and no body upsert is attempted.
- Added `lib/intelligence/pipeline-run-route.ts`, a dependency-injected best-effort route lifecycle helper. All six core cron routes now use shared start/settle handling; archive and audio early query-error returns use the helper that records failure before returning the unchanged primary `NextResponse`.
- Added executable route-integration contracts proving recorder start/settle failures do not replace primary success, handled-response, or thrown errors, plus structural assertions that all six routes use the shared lifecycle.

### TDD evidence

- RED: `npm run test:historical-persist` initially failed because `createHistoricalPersistenceRepository` did not exist.
- GREEN: it passed after compact lookup pagination, injected repository support, and truthful classification failure handling.
- RED: `npm run test:intelligence-pipeline-route` initially failed with missing `pipeline-run-route` module.
- GREEN: it passed after the shared best-effort helper was implemented and all six routes were wired to it.

### Files added or changed in this round

- `lib/historical-crawl/persist.ts`
- `lib/intelligence/pipeline-run-route.ts`
- `scripts/test-historical-crawl-persist.ts`
- `scripts/test-intelligence-pipeline-route.ts`
- `app/api/cron/daily-discovery-home/route.ts`
- `app/api/cron/daily-discovery-live/route.ts`
- `app/api/cron/daily-broadcasts/route.ts`
- `app/api/cron/daily-historical-broadcasts/route.ts`
- `app/api/cron/archive-videos/route.ts`
- `app/api/cron/analyze-broadcast-audio/route.ts`
- `package.json`

### Exact verification run

All commands exited 0:

`npm run test:intelligence-pipeline-run`
`npm run test:intelligence-pipeline-route`
`npm run test:intelligence-snapshot-schema`
`npm run test:historical-persist`
`npm run test:pipeline-health`
`npm run test:discovery-cron-budget`
`npm run test:video-archive-deadline`
`npm run test:broadcast-intel` (all six component checks passed)
`npx tsc --noEmit`
`git diff --check`

### Self-review

- Lookup URL size is independent of product-name length; each request contains only at most 31 ISO dates and the bounded source-channel set. Pagination avoids truncating existing rows.
- The persistence lookup failure branch intentionally does not issue the previously working upsert: without classification it cannot truthfully report inserted versus updated counts.
- Route response bodies/statuses, domain tables, queue selection, and primary thrown errors remain unchanged. The shared helper only isolates normalized recorder failures.

---

## Review fix round 3/5

### Findings addressed

- Added `failPipelineRunWithKnownCounts()`. It independently catches a count-heartbeat rejection and then attempts terminal `fail()`; a terminal failure is also isolated, so neither can replace the route’s primary result.
- Daily broadcast and historical all-source-failure paths now use that primitive instead of chaining heartbeat/fail in one callback.
- Added production-used named mapping functions in every one of the six route modules. `scripts/test-intelligence-pipeline-route.ts` imports the six route modules and executes their actual count/outcome functions rather than relying only on helper-name regexes.
- Added production-used archive/audio early-return functions and identity tests proving their unchanged primary response objects are returned even when recorder fail recording rejects.

### Covering tests and results

- `scripts/test-intelligence-pipeline-route.ts`: heartbeat-reject/fail-success and both-reject settlement cases; all six imported route mappings; archive/audio actual early-return response identity; shared start/settle and thrown-error identity contracts. Passed.
- `scripts/test-intelligence-pipeline-run.ts`: existing recorder lifecycle suite. Passed.
- `scripts/test-historical-crawl-persist.ts`: compact long-name lookup and classification-unavailable persistence behavior. Passed.

### Verification commands

All exited 0:

`npm run test:intelligence-pipeline-run`
`npm run test:intelligence-pipeline-route`
`npm run test:historical-persist`
`npm run test:pipeline-health`
`npm run test:discovery-cron-budget`
`npm run test:video-archive-deadline`
`npm run test:broadcast-intel`
`npx tsc --noEmit`
`git diff --check`

### Files changed

- `lib/intelligence/pipeline-run-route.ts`
- `scripts/test-intelligence-pipeline-route.ts`
- six Task 4 cron route files
- `.superpowers/sdd/2026-08-29-data-intelligence-foundation/task-4-report.md`

### Self-review

- The terminal-failure attempt now survives heartbeat rejection in both affected source-failure paths.
- The tests execute route-module exports that GET uses for route-specific normalized mapping. Archive/audio early-return wrappers are also production-used and preserve exact response identity.
- HTTP body/status behavior, domain tables, compact persistence lookup, and queue selection are unchanged.
