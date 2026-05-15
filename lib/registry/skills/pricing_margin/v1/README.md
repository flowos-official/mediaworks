# pricing_margin · v1

Skill 3 of the MD Strategy pipeline. Reads `priorOutputs.product_selection` (tier1 codes) and `priorOutputs.channel_strategy` (fee structure, priorities) to produce per-product / per-channel pricing recommendations with margin reasoning, plus BEP analysis per channel.

## Output

- `product_pricing[]` — cost_basis + channel_pricing[]
- `bep_analysis[]` — fixed_costs, variable_cost_per_unit, BEP units/revenue/timeline
- `margin_optimization[]` — free-text levers

## Model

- `gemini-3-flash-preview`, MINIMAL thinking

## Change log

- **v1 (2026-05-13)** — initial registry version, re-exports `buildPricingMarginPrompt`.
