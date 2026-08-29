# Task 1 Report: Canonical Product and Evidence Schema

## What I implemented

Added the additive `canonical_products`, `product_source_links`, and `evidence_items` tables with the exact columns, constraints, indexes, foreign keys, uniqueness rules, provenance fields, observation timestamps, and authenticated read RLS policies specified in the brief. Added the focused schema contract test and npm script.

## Tests and exact results

- `npm run test:intelligence-identity-schema` — exit 0; `PASS: intelligence identity schema`.
- `npm run test:migrations` — exit 0; all migration verification checks passed and ended with `✅ All migrations appear applied successfully.`
- `git diff --check` — exit 0; no whitespace errors.

## TDD evidence

### RED

Command: `npx tsx scripts/test-intelligence-identity-schema.ts`

Result: exit 1 with `Error: ENOENT: no such file or directory, open 'supabase/migrations/20260829130000_intelligence_identity_evidence.sql'`. This was the expected missing-migration failure.

### GREEN

Command: `npm run test:intelligence-identity-schema`

Result: exit 0 with `PASS: intelligence identity schema`.

## Files changed

- `supabase/migrations/20260829130000_intelligence_identity_evidence.sql`
- `scripts/test-intelligence-identity-schema.ts`
- `package.json`

## Self-review findings

Verified exact schema names, constraints, policies, indexes, provenance/observation fields, dedupe uniqueness, and no extra `revokedAt` column. Scope is additive and limited to the requested files. `git diff --check` is clean.

## Issues or concerns

None.
