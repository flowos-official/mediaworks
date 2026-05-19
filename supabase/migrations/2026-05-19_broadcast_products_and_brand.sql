-- 2026-05-19: competitive snapshot archival schema
-- Spec: docs/superpowers/specs/2026-05-19-competitive-snapshot-archival-design.md

BEGIN;

-- 1) broadcasts gains brand attribution columns (sourced from JSON-LD brand for
--    QVC, JSON brandname/brandcode for ShopCh).
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS brand_code text;

-- 2) qvc_products gains discount snapshot fields parsed from the product page's
--    inline utag_data block (no extra HTTP — parsed during existing enrich).
ALTER TABLE qvc_products
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS original_price_jpy int,
  ADD COLUMN IF NOT EXISTS sale_label text;

-- 3) broadcast_products — append-only per-slot per-product snapshot.
CREATE TABLE IF NOT EXISTS broadcast_products (
  broadcast_id        uuid        NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  product_id          text        NOT NULL,
  position            int         NOT NULL,
  name                text,
  image_url           text,
  price_jpy           int,
  original_price_jpy  int,
  discount_rate       int,
  sale_label          text,
  tax_incl            boolean,
  in_stock_at_capture boolean,
  source              text        NOT NULL CHECK (source IN ('qvc', 'shopch')),
  captured_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (broadcast_id, product_id)
);

CREATE INDEX IF NOT EXISTS broadcast_products_product_idx
  ON broadcast_products (product_id);
CREATE INDEX IF NOT EXISTS broadcast_products_captured_idx
  ON broadcast_products (captured_at DESC);

ALTER TABLE broadcast_products ENABLE ROW LEVEL SECURITY;

-- Group A pattern: member/admin read, service_role write.
-- Mirrors the policy in 2026-05-17_channel_categories_and_columns.sql.
-- NOTE: table is 'profiles' (not 'user_profiles') — consistent with all prior migrations.
DROP POLICY IF EXISTS broadcast_products_select ON broadcast_products;
CREATE POLICY broadcast_products_select
  ON broadcast_products
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role IN ('member', 'admin')
    )
  );

COMMIT;
