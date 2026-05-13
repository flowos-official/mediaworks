# channel_strategy · v1

Skill 2 of the MD Strategy pipeline. Foundational — downstream skills (pricing_margin / marketing_execution / financial_projection / risk_contingency) all read its output via `priorOutputs.channel_strategy`.

Takes the product_selection output and elaborates each candidate channel into: fit score, entry requirements (docs, setup timeline, initial costs), fee structure (commission, fulfillment, ad minimums), competitive landscape, operations requirements, KPIs. Also produces a phased `launch_sequence`.

## Model

- `gemini-3-flash-preview`, MINIMAL thinking

## Change log

- **v1 (2026-05-13)** — initial registry version, re-exports `buildChannelStrategyPrompt`.
