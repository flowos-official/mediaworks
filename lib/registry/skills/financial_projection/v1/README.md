# financial_projection · v1

Skill 5 of the MD Strategy pipeline. Produces a 12-month per-channel revenue/cost/profit forecast, channel-level ROI timeline (breakeven month, year-1 ROI%), and three scenarios (conservative/moderate/aggressive) with assumptions.

Reads `priorOutputs.product_selection`, `priorOutputs.channel_strategy`, `priorOutputs.pricing_margin`, `priorOutputs.marketing_execution`.

## Model

- `gemini-3-flash-preview`, MINIMAL thinking

## Change log

- **v1 (2026-05-13)** — initial registry version, re-exports `buildFinancialProjectionPrompt`.
