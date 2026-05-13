# goal_analysis · v1

First skill in the MD Strategy 7-skill pipeline. Parses the user's free-text expansion goal (the `拡大の目標・方向性` textarea on the strategy panel) into a structured `ParsedGoal` consumed by all downstream skills via `buildGoalSection()`.

## Input

| Field | Type | Notes |
|---|---|---|
| `userGoal` | string | The raw user text. May be any length; the prompt forwards it verbatim. |

## Output (Zod-validated)

| Field | Type | Notes |
|---|---|---|
| `primary_objective` | string | Required. Empty string allowed if no clear objective. |
| `target_channels` | `string[]` | Required. Empty array if no channels named — **never null** (see PR #16 incident). |
| `target_revenue` | string \| null | null if not mentioned |
| `target_audience` | string \| null | null if not mentioned |
| `budget_constraint` | string \| null | null if not mentioned |
| `timeline` | string \| null | null if not mentioned |

## Model

- Provider: Google
- Model: `gemini-3-flash-preview`
- Thinking: MINIMAL (flash default; pro fallback uses LOW per `callGemini` retry chain)

## Change log

- **v1 (2026-05-13)** — initial registry version. Verbatim port of `lib/md-strategy.ts:runGoalAnalysis` as of commit `e75c945`. Includes the null-guard fix from PR #16 (target_channels must be array, never null).

## Known limitations

- No deterministic validator slugs yet — Phase A will add schema-strict + cross-skill-consistency checks.
- The runtime normalization (null → undefined) currently lives in `lib/md-strategy.ts`; once Step 11's `runPipeline()` ships, that logic moves to the runner layer.
