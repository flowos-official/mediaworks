# generate_weekly_insight · v1

Weekly summary of discovery feedback per context. Takes a `WeeklyInsightInput` (sourced/rejected/interested counts, top categories, rejection reasons, win rates) and produces a 3-field narrative.

Note: the data-aggregation step (`aggregateWeek`) is not in the registry — it's a pure SQL aggregator with no LLM call.

## Change log

- **v1 (2026-05-13)** — initial registry version.
