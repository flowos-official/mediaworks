# product_selection · v1

Skill 1 of the MD Strategy 7-skill pipeline. Foundational — if it fails the downstream skills are skipped (channel_strategy / pricing_margin / marketing_execution / financial_projection / risk_contingency all read its output via `priorOutputs.product_selection`).

## Input

`StrategyContext` — built by `fetchStrategyContext` in `lib/md-strategy.ts`. Includes top 30 TV products with enriched metrics, parsed goal (if any), Brave search sources, optional seed product.

## Output (Zod-validated)

- `channel_product_matrix` — for each candidate channel, tier1/tier2/exclusion lists with reasoning
- `portfolio_strategy` — free-text narrative
- `sources_cited` — optional citation array

Note: the runtime orchestrator subsequently injects `discovered_new_products` and `discovery_history` into the output (Strategy ↔ Discovery pool integration). Those fields are NOT part of the LLM contract here.

## Model

- `gemini-3-flash-preview`, MINIMAL thinking, Google provider

## Change log

- **v1 (2026-05-13)** — initial registry version. Re-exports `buildProductSelectionPrompt` from `lib/md-strategy.ts` at commit `40a782f`.
