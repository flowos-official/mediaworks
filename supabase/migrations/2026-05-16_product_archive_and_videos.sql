-- Product archive + video storage
--
-- Captures everything we need to keep about a discovered product even after
-- the source site removes it:
--   * full image set (S3)
--   * raw HTML snapshot (gzipped, S3) + extracted text
--   * preview/digest video (HLS → MP4 720p, S3)
--   * price/stock history (separate snapshot rows)
--
-- Mirrors the same archive columns on `qvc_products` so QVC enrich can store
-- the same things without re-modelling.

-- 1) discovered_products: archive columns -------------------------------------

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS archived_thumbnail_s3   text,
  ADD COLUMN IF NOT EXISTS archived_image_s3       text[],
  ADD COLUMN IF NOT EXISTS video_source_url        text,
  ADD COLUMN IF NOT EXISTS archived_video_s3       text,
  ADD COLUMN IF NOT EXISTS video_size_bytes        bigint,
  ADD COLUMN IF NOT EXISTS video_duration_sec      int,
  ADD COLUMN IF NOT EXISTS video_quality           text,
  ADD COLUMN IF NOT EXISTS archived_html_s3        text,
  ADD COLUMN IF NOT EXISTS archived_text           text,
  ADD COLUMN IF NOT EXISTS is_still_available      boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_seen_at            timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS first_archived_at       timestamptz,
  ADD COLUMN IF NOT EXISTS archive_status          text DEFAULT 'pending'
    CHECK (archive_status IN ('pending','running','partial','complete','failed')),
  ADD COLUMN IF NOT EXISTS archive_attempts        smallint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archive_error           text;

CREATE INDEX IF NOT EXISTS idx_dp_archive_status
  ON discovered_products (archive_status);
CREATE INDEX IF NOT EXISTS idx_dp_last_seen
  ON discovered_products (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_dp_still_available
  ON discovered_products (is_still_available)
  WHERE is_still_available = false;

-- 2) product_snapshots: time-series of price/stock per product ----------------
-- One row per (product, snapshot date). Daily job appends a row only when
-- something changed (or once a day baseline).

CREATE TABLE IF NOT EXISTS product_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_product_id uuid NOT NULL
    REFERENCES discovered_products(id) ON DELETE CASCADE,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  price_jpy int,
  stock_status text,
  is_available boolean,
  raw_meta jsonb,
  UNIQUE (discovered_product_id, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_ps_product
  ON product_snapshots (discovered_product_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_ps_snapshot_at
  ON product_snapshots (snapshot_at DESC);

-- 3) qvc_products: same archive surface ---------------------------------------

ALTER TABLE qvc_products
  ADD COLUMN IF NOT EXISTS archived_thumbnail_s3   text,
  ADD COLUMN IF NOT EXISTS archived_image_s3       text[],
  ADD COLUMN IF NOT EXISTS archived_video_s3       text,
  ADD COLUMN IF NOT EXISTS video_size_bytes        bigint,
  ADD COLUMN IF NOT EXISTS video_duration_sec      int,
  ADD COLUMN IF NOT EXISTS video_quality           text,
  ADD COLUMN IF NOT EXISTS archived_html_s3        text,
  ADD COLUMN IF NOT EXISTS archived_text           text,
  ADD COLUMN IF NOT EXISTS is_still_available      boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_seen_at            timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS first_archived_at       timestamptz,
  ADD COLUMN IF NOT EXISTS archive_status          text DEFAULT 'pending'
    CHECK (archive_status IN ('pending','running','partial','complete','failed')),
  ADD COLUMN IF NOT EXISTS archive_attempts        smallint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archive_error           text;

CREATE INDEX IF NOT EXISTS idx_qvcp_archive_status
  ON qvc_products (archive_status);

-- 4) shopch_products: NEW — mirror of qvc_products for Shop Channel ----------
-- Populated from /json/programprodlist2/{slotKey}.json (single endpoint per
-- slot containing prodList1 + meta — no JS rendering required).

CREATE TABLE IF NOT EXISTS shopch_products (
  id              text PRIMARY KEY,           -- reqPrNo (e.g. "819208")
  name            text,
  brand           text,
  category        text,
  price_jpy       int,
  compare_price_jpy int,
  off_rate        smallint,
  image_url       text,
  source_url      text NOT NULL,
  -- archive surface (same shape as qvc_products)
  archived_thumbnail_s3 text,
  archived_image_s3     text[],
  archived_video_s3     text,
  video_size_bytes      bigint,
  video_duration_sec    int,
  video_quality         text,
  archived_html_s3      text,
  archived_text         text,
  is_still_available    boolean DEFAULT true,
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  first_archived_at     timestamptz,
  archive_status        text DEFAULT 'pending'
    CHECK (archive_status IN ('pending','running','partial','complete','failed')),
  archive_attempts      smallint DEFAULT 0,
  archive_error         text,
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shopchp_fetched
  ON shopch_products (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopchp_archive_status
  ON shopch_products (archive_status);

CREATE OR REPLACE FUNCTION shopch_products_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS shopch_products_updated_at_trg ON shopch_products;
CREATE TRIGGER shopch_products_updated_at_trg
  BEFORE UPDATE ON shopch_products
  FOR EACH ROW EXECUTE FUNCTION shopch_products_set_updated_at();

-- 5) broadcasts: video archive columns for full-slot videos -------------------
-- Shop Channel slot video (~2h) saved as 720p MP4. product_ids already exists.

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS video_source_url        text,
  ADD COLUMN IF NOT EXISTS archived_video_s3       text,
  ADD COLUMN IF NOT EXISTS video_size_bytes        bigint,
  ADD COLUMN IF NOT EXISTS video_duration_sec      int,
  ADD COLUMN IF NOT EXISTS video_quality           text,
  ADD COLUMN IF NOT EXISTS video_status            text DEFAULT 'pending'
    CHECK (video_status IN ('pending','running','done','failed','skipped')),
  ADD COLUMN IF NOT EXISTS video_downloaded_at     timestamptz,
  ADD COLUMN IF NOT EXISTS video_download_attempts smallint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS video_error             text;

CREATE INDEX IF NOT EXISTS idx_broadcasts_video_status
  ON broadcasts (video_status, air_date DESC);
