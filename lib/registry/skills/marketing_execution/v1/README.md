# marketing_execution · v1

Skill 4 of the MD Strategy pipeline. Produces 6-month monthly marketing plans, a content calendar, an influencer-tier plan, and a budget summary broken down by channel and content type.

Reads `priorOutputs.product_selection` (which products to push) and `priorOutputs.channel_strategy` (channel KPIs and priorities).

## Model

- `gemini-3-flash-preview`, MINIMAL thinking

## Change log

- **v1 (2026-05-13)** — initial registry version, re-exports `buildMarketingExecutionPrompt`.
