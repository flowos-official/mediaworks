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
