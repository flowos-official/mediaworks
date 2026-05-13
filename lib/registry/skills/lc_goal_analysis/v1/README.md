# lc_goal_analysis · v1

Live Commerce Skill 0. Parallel to md_strategy's `goal_analysis` but produces a different `ParsedGoal` shape — `target_platforms` (TikTok/Instagram/YouTube/楽天ROOM/Yahoo! LIVE) instead of `target_channels`. Default fallback is `["TikTok Live", "Instagram Live", "YouTube Live"]` when the user doesn't name platforms.

## Model

- `gemini-3-flash-preview`, MINIMAL thinking

## Change log

- **v1 (2026-05-13)** — initial registry version, re-exports `buildLCGoalAnalysisPrompt` (extracted in this PR from the previous inline `runGoalAnalysis` function).
