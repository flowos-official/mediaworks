# category_plan · v1

Discovery Stage 0. Generates the day's keyword plan respecting:

- `learning.exploration_ratio` (0.2–0.67 bandit-adjusted nightly)
- `learning.category_weights` (top-10 outcome-weighted scores in 0.0–3.0, sorted desc; 0.5 = neutral. Was a 0.0–1.0 win-rate before the 2026-05-29 selection-outcome loop)
- `learning.category_seasonal_weights` (clipped 0.3–2.0 by JST month)
- `learning.recent_rejection_reasons` (top-3 deprioritized terms)
- `topCategories` from recent TV sales
- `recentlyUsed` from prior day plans (deprioritized)
- `context` (home_shopping vs live_commerce — different demographic guidance)

Falls back deterministically to `topCategories` + `FALLBACK_EXPLORATION` if Gemini fails.

## Output

`{ tv_proven: string[], exploration: string[], reasoning?: string }`

## Change log

- **v1 (2026-05-13)** — initial registry version.
