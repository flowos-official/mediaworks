-- 2026-05-26: products に error_reason + updated_at を追加。
-- stuck detection cron が最終状態変化時刻で stuck 判定する。
-- error_reason は detection (trigger_not_invoked / analysis_timeout) と
-- analyze ルートの CRON_SECRET 欠落など、明示的失敗で埋められる。

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS error_reason text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION update_products_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at_trigger ON products;
CREATE TRIGGER products_updated_at_trigger
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION update_products_updated_at();

COMMIT;
