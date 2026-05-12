-- Phase B PoC (QVC only): per-broadcast product list + product detail cache

-- 1) 각 방송 슬롯이 다룬 QVC 제품 ID 목록
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS product_ids text[];

-- 2) QVC 제품 상세 캐시 — qvc.jp/product.NNN.html 에서 OG 메타로 채움
CREATE TABLE IF NOT EXISTS qvc_products (
  id              text PRIMARY KEY,
  name            text,
  description     text,
  image_url       text,
  image_urls      text[],
  video_url       text,
  price_text      text,
  source_url      text NOT NULL,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qvc_products_fetched_idx
  ON qvc_products (fetched_at DESC);

CREATE OR REPLACE FUNCTION qvc_products_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS qvc_products_updated_at_trg ON qvc_products;
CREATE TRIGGER qvc_products_updated_at_trg
  BEFORE UPDATE ON qvc_products
  FOR EACH ROW EXECUTE FUNCTION qvc_products_set_updated_at();
