-- 2026-05-26: products に created_by を追加。Phase 4 の IDOR check 用。
-- nullable (既存 row + cron 生成 row は NULL 維持)。
-- application layer で owner / admin 判定 — RLS は変更しない。

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_created_by ON products(created_by);

COMMIT;
