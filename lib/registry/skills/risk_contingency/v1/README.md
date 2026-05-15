# risk_contingency · v1

Skill 6 (last) of the MD Strategy pipeline. Produces:

- `risk_matrix[]` — per-channel risk list with category / likelihood / impact / mitigation / contingency triggers
- `top_5_risks[]` — escalated risks with mitigation playbook and owner
- `go_nogo_criteria[]` — per-channel decision gates with target dates

Reads outputs of all 5 prior skills via `priorOutputs`.

## Model

- `gemini-3-flash-preview`, MINIMAL thinking

## Change log

- **v1 (2026-05-13)** — initial registry version, re-exports `buildRiskContingencyPrompt`.
