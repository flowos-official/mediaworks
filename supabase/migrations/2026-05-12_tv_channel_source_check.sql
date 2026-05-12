-- Extend discovered_products.source CHECK constraint to allow 'tv_channel'.
-- Original constraint (in 2026-04-18_discovery_system.sql) was:
--   CHECK (source IN ('rakuten','brave','other'))
-- The discovery TV channel feature added 'tv_channel' as a new source value;
-- without this update INSERTs from buildPool fail with discovered_products_source_check.

ALTER TABLE discovered_products
  DROP CONSTRAINT IF EXISTS discovered_products_source_check;

ALTER TABLE discovered_products
  ADD CONSTRAINT discovered_products_source_check
  CHECK (source IN ('rakuten', 'brave', 'tv_channel', 'other'));
