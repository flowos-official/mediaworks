# discover_curation · v1

Final stage of the MD Strategy pipeline. Takes the strategy context + analysis context (after all 7 prior skills) and curates a list of real, in-market products that the user could source.

## Why it's a multi-stage skill

Unlike the 7 prompt-only skills in `md_strategy`, this one combines:

1. **Pool-first query** of `discovered_products` (Strategy ↔ Discovery integration — `2026-05-13` plan)
2. **Optional Rakuten + Brave fresh search** to fill pool deficits
3. **Large Gemini prompt** with TV self-sales signals, Japan-market trends, and the deduplicated pool list
4. **Gemini ranks/scores/annotates** each candidate with `japan_fit_score` (0-100) using a strict additive rubric
5. **Sanity-pass filter** that rejects items not anchored to the pool (anti-hallucination)
6. **Pool index restore** so `pool_source` and `discovered_product_id` are preserved for badge display

## Output (Zod-validated)

`DiscoveredProduct[]` — each entry has name, reason, japan_fit_score, source URL, signal_basis, japan_market_fit (popularity_evidence / trend_context / why_japan_now / review_signal), optional sales_strategy (full v.s. lightweight mode), and post-hoc fields (pool_source, discovered_product_id, tv_channel_source).

## v1 design

Per the same pattern as `enrich_product`, this v1 catalogs the entire `discoverNewProducts` function via `Function.prototype.toString()` rather than extracting the inline prompt. The function assembles 10+ context strings (signalText, japanMarketContext, poolText, suitabilityBlock, salesStrategySchema, etc.) before constructing the prompt; clean extraction would require restructuring the multi-stage logic.

## Change log

- **v1 (2026-05-13)** — closes PR δ1.5 (last skill in the bulk migration series). Catalogs the existing function as-is.
