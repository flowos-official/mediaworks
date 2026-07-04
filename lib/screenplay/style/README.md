# Per-tenant style bibles

`loadStyleBible(tenant)` reads `{tenant}.json` here, falling back to
`../style-bible.json` when the tenant file is absent.

- `mediaworks` → falls back to the base `style-bible.json` (no override file).
- `tokyo_tv` → add `tokyo_tv.json` once Tokyo-TV past scripts (B-1) are ingested
  and a house-style profile is distilled from them.
