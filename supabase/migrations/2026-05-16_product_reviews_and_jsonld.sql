-- Reviews + richer JSON-LD-derived fields.
--
-- product_reviews:  one row per (channel, product_id, external_id).
-- Each channel uses its own product-id space — QVC uses reqPrNo, Shop Channel
-- also uses reqPrNo, discovered_products uses UUID. So we key by (channel,
-- product_id, external_id) and keep the source-of-truth raw JSON as well.

CREATE TABLE IF NOT EXISTS product_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL,                         -- 'qvc' | 'shopch' | 'discovery'
  product_id      text NOT NULL,                         -- channel-specific product id
  external_id     text NOT NULL,                         -- review id from upstream API
  rating          smallint,                              -- 1..5
  title           text,
  comment         text,
  recommended     boolean,
  status          text,                                  -- e.g. 'APPROVED'
  reviewer_nickname text,
  reviewer_profile_pic text,
  reviewer_gender text,
  variant_info    jsonb,                                 -- variantAxis array
  review_date     timestamptz,
  raw             jsonb NOT NULL,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, product_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_channel_product ON product_reviews (channel, product_id, review_date DESC);
CREATE INDEX IF NOT EXISTS idx_pr_rating ON product_reviews (rating);
CREATE INDEX IF NOT EXISTS idx_pr_fetched ON product_reviews (fetched_at DESC);

-- Per-product review aggregates + structured JSON-LD fields ----------------

ALTER TABLE qvc_products
  ADD COLUMN IF NOT EXISTS review_count           int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_avg             numeric(3,2),
  ADD COLUMN IF NOT EXISTS reviews_fetched_at     timestamptz,
  ADD COLUMN IF NOT EXISTS description_long       text,           -- JSON-LD VideoObject.description (long, with <br>)
  ADD COLUMN IF NOT EXISTS sku_variants           jsonb,          -- JSON-LD Product.offers[] array
  ADD COLUMN IF NOT EXISTS video_upload_date      timestamptz,    -- JSON-LD VideoObject.uploadDate
  ADD COLUMN IF NOT EXISTS jsonld_raw             jsonb;          -- the raw JSON-LD blocks for future re-extraction

ALTER TABLE shopch_products
  ADD COLUMN IF NOT EXISTS review_count           int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_avg             numeric(3,2),
  ADD COLUMN IF NOT EXISTS reviews_fetched_at     timestamptz,
  ADD COLUMN IF NOT EXISTS description_long       text,
  ADD COLUMN IF NOT EXISTS sku_variants           jsonb,
  ADD COLUMN IF NOT EXISTS jsonld_raw             jsonb;

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS review_count           int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_avg             numeric(3,2),
  ADD COLUMN IF NOT EXISTS reviews_fetched_at     timestamptz,
  ADD COLUMN IF NOT EXISTS description_long       text,
  ADD COLUMN IF NOT EXISTS sku_variants           jsonb,
  ADD COLUMN IF NOT EXISTS jsonld_raw             jsonb;
