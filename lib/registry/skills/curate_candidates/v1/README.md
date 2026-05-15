# curate_candidates · v1

Discovery Stage 1. Takes the merged PoolItem[] (Rakuten + Brave + TV-channel sources), applies seasonal hints, and asks Gemini to score TV/EC fit per item with a 5-component breakdown (review_signal, tv_category_match, trend_signal, price_fit, purchase_signal). Output is the curated subset with reasoning.

## Schema note

The Zod output is `.passthrough()` because the runtime Candidate type extends PoolItem with many DB-side fields the LLM doesn't produce. The schema constrains only what the LLM contributes.

## Change log

- **v1 (2026-05-13)** — initial registry version.
