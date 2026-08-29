# Task 9: Category-Balanced Broadcast Analysis Queue

## Status

Implemented category-balanced broadcast analysis queue selection without any live queue action or environment-file change.

## RED / GREEN

- RED: `npx tsx scripts/test-broadcast-intel-priority.ts` failed with `Cannot find module '../lib/broadcast-intel/priority'` before the pure selector existed.
- GREEN: the focused test passes the pure priority, queue repository, pagination, repeat-identity, idempotent-promotion, cron, and drain contracts.
- RED: adding the drain scope contract failed with `Cannot find module '../lib/broadcast-intel/drain-scope'`; adding the production-used scope helper made it pass.
- RED: adding the cron contract failed with `broadcastAudioSeedOptions is not a function`; the route-owned balanced options helper made it pass.

## Query and Balancing Behavior

- An omitted category fetches at most 200 pending, archived QVC/ShopCh candidates before any in-memory priority work. An explicit category remains an exact operator filter.
- Completed analysis counts page through `broadcast_speech_analyses` in 1,000-row ranges, deduplicate by `broadcast_id`, and group by normalized category. Blank/null values map only to the stable internal `\0broadcast-analysis-unclassified` balancing key; stored candidate categories are never replaced.
- The tuple is analyzed sample count ascending, repeat count descending, air date descending, and ID ascending. The selector takes one prioritized candidate per available category each round.
- Repeat count is derived only within the bounded candidate pool. Its identity key is channel plus sorted unique nonblank `product_ids`; absent IDs use channel plus whitespace-normalized `program_title`; absent both uses the broadcast ID and therefore cannot create a false repeat.
- Promotion remains two-step and guarded with `analysis_status = 'pending'`, so concurrent/second seed calls count only rows actually promoted.

## Tests and Output

All exited 0:

- `npm run test:broadcast-intel-priority` — 13 priority, bounds, pagination, idempotency, cron, drain, and production-adapter contracts passed.
- `npm run test:broadcast-intel` — schema, audio, aggregate, prompt, guard, and storage passed.
- `npm run test:intelligence-pipeline-route` — route-owned mapping, early-return, thrown-error, and normalized lifecycle contracts passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

## Files

- Added `lib/broadcast-intel/priority.ts`, `lib/broadcast-intel/drain-scope.ts`, and `scripts/test-broadcast-intel-priority.ts`.
- Updated `lib/broadcast-intel/queue.ts`, `app/api/cron/analyze-broadcast-audio/route.ts`, `scripts/drain-broadcast-analysis.ts`, and `package.json`.

## Self-Review

- Cron has no `BROADCAST_INTEL_CATEGORY` or category default; its normalized outcome mappings, early-query return, thrown-error boundary, counts, concurrency, and deadline loop are unchanged.
- A drain category is applied to reset, seeding, and queued-slot selection only when explicitly supplied; absent category uses the same balanced seed path as cron.
- Candidate, completion-count, and promotion contracts run against the production repository implementation with a controlled Supabase boundary; no external service is invoked.

## Concerns

The balanced path intentionally returns at most 200 candidates even if an internal caller asks for more; cron (10) and the drain's validated ceiling (100) remain below that bound.

## Round 1 Review Fix Evidence

### Root Cause

- The balanced candidate query used `min(requested, 200)`, so a 10-slot invocation could never see a valid alternative at row 11.
- The first refactor removed the per-channel category whitelist rather than carrying it into the bounded candidate query.
- Category counts read the category copied into `broadcast_speech_analyses`, which can become stale after current broadcast enrichment changes it.
- The drain's raw flag parser returned an empty string for `--category=`, allowing reset/seed/process scoping to diverge.

### RED / GREEN

- RED: the ten-newest-plus-eleventh-alternative test failed because `fashion-11` was absent from the promoted set. GREEN after balanced mode always requests the full 200-row eligible pool before selecting the requested limit.
- RED: whitelist scope tests failed because `buildEligibleAnalysisScopes` did not exist; the pre-cap invalid/blank overscan test then failed because no scopes reached the repository. GREEN after reusing `CATEGORIES_BY_CHANNEL` to build trusted per-channel query scopes.
- RED: corrected-current-category pagination test returned `stale: 1001`. GREEN after completed IDs are deduplicated then resolved from current `broadcasts` rows in 200-ID chunks.
- RED: blank drain parser test failed because `parseDrainCategory` did not exist. GREEN after the production drain parses once, rejects blank/whitespace values, and reuses its validated scope for reset, seed, and queued-slot processing.

### Query / Queue Behavior

- Balanced seeding always asks for at most 200 eligible rows, independent of output limit. Category eligibility is an indexable `channel` plus whitelist-category predicate in the database before `.limit(200)`; no all-history scan or unbounded overscan occurs.
- Explicit categories stay exact and only produce channel scopes where that category is whitelisted. Invalid/blank/non-whitelist candidate rows cannot consume the balanced window.
- Analysis pagination reads only `broadcast_id` from `broadcast_speech_analyses` in 1,000-row pages. Unique IDs are resolved against current `broadcasts(id, category)` in 200-ID chunks; missing rows/null/blank categories enter only the internal unclassified balancing bucket.
- The two-step pending-status guard and actual update-return count remain unchanged, including partial concurrent promotion races.

### Round 1 Tests and Output

All commands exited 0:

- `npm run test:broadcast-intel-priority` — 19 contracts passed, including full-pool balancing, pre-cap whitelist filtering, unavailable whitelist, stale-current-category correction, page/chunk failures, partial promotion, and blank drain categories.
- `npm run test:broadcast-intel` — schema, audio, aggregate, prompt, guard, and storage passed.
- `npm run test:intelligence-pipeline-route` — all Task 4 route mapping, early-return, thrown-error, and lifecycle contracts passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

### Round 1 Files

- Updated `lib/broadcast-intel/queue.ts`, `lib/broadcast-intel/drain-scope.ts`, `scripts/drain-broadcast-analysis.ts`, and `scripts/test-broadcast-intel-priority.ts`.

### Round 1 Self-Review

- Cron still has no category default; its Task 4 normalized telemetry mapping, early returns, thrown errors, counts, concurrency, and deadline behavior were not changed.
- Whitelist values are repository-owned constants; explicit operator input can only select a matching constant before being interpolated into the trusted PostgREST filter.
- Current-category lookup errors and completed-analysis page errors throw rather than silently undercount. Every completed ID is counted once, and unresolved current rows are explicitly unclassified.
- No live queue operation or environment-file mutation occurred.
