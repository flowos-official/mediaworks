# enrich_product · v1

The only true multi-step **agent** in the registry today. Runs a Gemini tool-calling loop to produce a complete `CPackage` for a discovered candidate.

## Per spec §15.4 (open question) — v1 design decision

Tool calling is **not** flattened in v1. The registry entry catalogs this skill as-is, with the entire `enrichProduct` function source captured in `promptSource` for audit. A future v2 (separate spec) will decompose the agent into individual tool-use skills (web-search, price-lookup, tv-script-delegate) and let `runPipeline()` orchestrate them.

Until then: runtime invocation continues to use `enrichProduct` directly, and the registry serves the admin-UI display purpose only.

## Output (CPackage)

- `manufacturer` — name / official_site / address / contact_hints with confidence
- `wholesale_estimate` — retail / cost / margin with `method` (baseline | blended | mediaworks_adjusted)
- `moq_hint` — free text or null
- `tv_script_draft` — Japanese broadcast script (delegated to `generate_tv_script_draft`)
- `sns_trend` — signal_strength + sources
- `enriched_at`, `tool_calls_used`, `partial`, `error?`

## Change log

- **v1 (2026-05-13)** — initial catalog entry; tool-call decomposition deferred.
