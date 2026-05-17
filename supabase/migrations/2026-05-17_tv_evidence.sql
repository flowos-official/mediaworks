-- TV Evidence Mining: per-candidate broadcast history aggregate.
-- Spec: docs/superpowers/specs/2026-05-17-tv-evidence-mining-design.md

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS tv_evidence jsonb;

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS tv_evidence_at timestamptz;

-- GIN index for keyset queries (e.g. find products with channel breakdown
-- containing 'qvc'). Partial — most rows will be null until the first
-- refresh cron run completes.
CREATE INDEX IF NOT EXISTS idx_discovered_products_tv_evidence_gin
  ON discovered_products USING gin (tv_evidence)
  WHERE tv_evidence IS NOT NULL;

-- Index to find stale rows quickly in the weekly refresh cron.
CREATE INDEX IF NOT EXISTS idx_discovered_products_tv_evidence_at
  ON discovered_products (tv_evidence_at NULLS FIRST);

-- No new RLS policy needed: columns inherit table-level RLS on
-- discovered_products. Verify in the migration runner output that existing
-- policies cover member/admin reads + viewer denial. If they don't,
-- that is a pre-existing bug — fix it before merging this migration.
