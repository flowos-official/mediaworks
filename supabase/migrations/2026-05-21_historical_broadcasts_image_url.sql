-- 2026-05-21_historical_broadcasts_image_url.sql
-- Adds an optional thumbnail URL for OA-channel slots.
-- Spec: docs/superpowers/specs/2026-05-21-oa-channel-images-design.md §4
--
-- RLS: existing policies cover the new column (column-level RLS not used).
-- Forward-compatible: existing readers ignore the column; writers can leave it null.

BEGIN;

ALTER TABLE historical_broadcasts
  ADD COLUMN IF NOT EXISTS image_url text NULL;

COMMENT ON COLUMN historical_broadcasts.image_url IS
  'Product thumbnail URL discovered via channel-specific extractor. Null when extraction failed, was skipped (japanet), or row predates the enrichment feature. Backfill via scripts/backfill-oa-images.ts.';

COMMIT;
