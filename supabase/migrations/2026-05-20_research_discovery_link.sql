-- 2026-05-20_research_discovery_link.sql
-- Links Research-pipeline products back to their Discovery origin.
-- Spec: docs/superpowers/specs/2026-05-20-research-cross-system-integration-design.md §6.1
--
-- RLS: products is Group B (member/admin-only per 2026-05-13_auth_rls_tight.sql).
-- The new columns inherit the existing policies — no policy changes needed.

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS discovered_product_id uuid NULL
  REFERENCES discovered_products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_p_discovered_product_id
  ON products (discovered_product_id)
  WHERE discovered_product_id IS NOT NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ingest_source text NOT NULL DEFAULT 'file_upload'
  CONSTRAINT products_ingest_source_valid
  CHECK (ingest_source IN ('file_upload', 'discovery_promotion', 'manual_url'));

COMMIT;
