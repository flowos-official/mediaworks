# Task 7 — Real Pipeline Readiness Model and API Report

## Status

Implemented the truthful, read-only intelligence readiness loader and private API route. No environment files, migrations, live new-table API calls, collection jobs, normalization, refresh, search, or generation were invoked.

## TDD evidence

1. RED: created `scripts/test-intelligence-readiness.ts` before the production module, then ran:

   ```text
   $ npx tsx scripts/test-intelligence-readiness.ts
   Error: Cannot find module '../lib/intelligence/readiness'
   ```

2. GREEN: implemented the pure helpers, injected repository/loader, and injected route boundary. The final focused test command reports:

   ```text
   > mediaworks@0.1.0 test:intelligence-readiness
   > tsx scripts/test-intelligence-readiness.ts

   PASS: intelligence readiness model and API boundary
   ```

The executable test covers latest-failure versus older success, healthy/stale/missing/partial state, inclusive freshness cutoff, future timestamps, zero denominators, integer rounding, source/job isolation, bounded recent failures, exact latest successful Discovery run IDs, source-identity/canonical deduplication, active internal source links, canonical/category intersections, archived/analyzed distinct IDs, duplicate-analysis suppression, exact-count heads, unapplied intelligence-table errors, and the real route dependency boundary.

## Query and denominator model

| Metric/read | Query shape | Result / denominator |
| --- | --- | --- |
| Source attempt and success | Two `data_pipeline_runs` reads per explicit `(source_type, job_type)`, each ordered by `started_at desc` and `limit(1)` | Keeps latest attempt distinct from latest success; no job-type mixing. Daily sources use 26h tolerance; the 2-hour archive worker uses 3h; backfill is explicitly on-demand. |
| Recent failures | `status = failed`, `started_at desc`, `limit(10)` | Ten most recent terminal failures only. |
| Active Discovery products | Paginated `discovered_products(id, session_id)` constrained to the latest successful `discovery/home_shopping` and `discovery/live_commerce` run IDs | Deduplicated by `discovery/discovered_products/id`; never reads historical discovery runs. |
| Internal products | Paginated `product_source_links` constrained to `source_type = internal_excel`, then active canonical IDs | Adds each active canonical internal product once, only when it has an internal source link. |
| Canonical/category coverage | Bounded source-link and active-canonical ID chunks (200 IDs) | Numerators are intersections against that exact active-product denominator; empty denominator returns `null`. |
| Broadcast coverage | Paginated archived `broadcasts(id, category)` and bounded `broadcast_speech_analyses(broadcast_id)` chunks | Archived IDs are the denominator; analyzed IDs are a set intersection, preventing duplicate-analysis inflation. |
| Evidence and insight totals | `select(id, { count: exact, head: true })` | Count-only reads avoid row payloads and surface missing tables as loader errors. |

All identity-bearing reads select only IDs and category/source-link fields, use 500-row pagination or 200-ID chunks, and avoid PostgREST's default 1,000-row truncation. The loader makes no writes.

## Files

- `lib/intelligence/readiness.ts` — contracts, pure helpers, read-only repository, and loader.
- `app/api/intelligence/status/route.ts` — viewer/member/admin authenticated `GET`, `private, no-store`, and stable 500 error code.
- `scripts/test-intelligence-readiness.ts` — injected repository and route tests; no live calls.
- `package.json` — `test:intelligence-readiness` script.

## Verification

Executed successfully after the final change:

```text
$ npm run test:intelligence-readiness
PASS: intelligence readiness model and API boundary

$ npx tsc --noEmit
(exit 0; no output)

$ git diff --check
(exit 0; no output)
```

## Self-review and concerns

- The loader never references `product_selections`, recommendation, Research, or Screenplay run counts.
- A newer failed or partial attempt remains `failed` even when an older successful run is fresh; future timestamps also fail closed.
- An unapplied `evidence_items` or `insight_snapshots` table rejects the loader and becomes HTTP 500 with `intelligence_status_failed`; it never fabricates zero coverage.
- The new intelligence migrations remain unapplied in this environment by design. Until deployed, the new API will report that loader error rather than a misleading readiness response.

## Round 1 — Discovery session namespace and OA freshness correction

### Root cause and TDD evidence

`data_pipeline_runs.id` is the telemetry record UUID. The Discovery crons create a distinct `discovery_runs` row first and store that `sessionId` in `data_pipeline_runs.external_run_id`; `discovered_products.session_id` references that external session ID. The original loader incorrectly used the telemetry UUID, yielding an empty Discovery membership set in production.

The regression fixtures now deliberately use distinct values (`home-success` versus `discovery-session-home`, and `live-success` versus `discovery-session-live`). Before the production fix, the focused test failed as expected:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
  activeProducts: 1
- activeProducts: 5
```

The green implementation selects `external_run_id` with both latest-run queries, maps only the latest successful Discovery rows through that value, and rejects missing or blank values with `latest successful Discovery <job> run is missing external_run_id`. It never falls back to `data_pipeline_runs.id`. The integrity validation occurs before the broader coverage queries, so it is not converted into an empty denominator.

OA historical crawling now has a documented `twice daily (20h tolerance)` window. Tests verify 20h inclusive health, stale at 20h + 1ms, and failed status for a latest partial or failed attempt despite an older successful crawl at the cutoff.

### Files changed in round 1

- `lib/intelligence/readiness.ts`
- `scripts/test-intelligence-readiness.ts`
- `.superpowers/sdd/2026-08-29-data-intelligence-foundation/task-7-report.md`

### Verification

Executed after the final round-1 implementation:

```text
$ npm run test:intelligence-readiness
PASS: intelligence readiness model and API boundary

$ npx tsc --noEmit
(exit 0; no output)

$ git diff --check
(exit 0; no output)
```

### Round-1 self-review

- The latest failed live Discovery telemetry row remains `failed`, while its older successful row's external session ID remains the exact denominator input.
- Home and live external IDs are distinct in the test fixture; their union is queried once and source identity remains deduplicated.
- `null` and whitespace-only Discovery external IDs are integrity errors, not fallbacks or zero coverage.
- Auth, cache headers, all read-only behavior, count heads, pagination, intersections, and other source windows are unchanged. No live authenticated request was made; that check remains deferred until Task 10.
