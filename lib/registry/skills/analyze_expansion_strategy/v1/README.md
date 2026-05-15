# analyze_expansion_strategy · v1 (LEGACY)

Pre-dates the 7-skill MD Strategy pipeline. A single Gemini call that takes overall TV-channel KPIs + top products + category breakdown and returns a `channel_recommendations / product_channel_fit / entry_strategy / risk_assessment / summary` bundle.

Used by the older `ExpansionAnalysis` panel (`/api/analytics/expansion` route). The newer 7-skill pipeline (`/api/analytics/md-strategy`) supersedes it but the legacy panel is still wired in the UI.

## Disposition

- **Cataloged for completeness** — gives the admin UI full visibility into what LLM calls the codebase makes.
- **Expect deprecation** once the legacy ExpansionAnalysis panel migrates over to the registered 7-skill workflow (separate PR).

## Change log

- **v1 (2026-05-13)** — initial catalog entry. No semantic change to the legacy function.
