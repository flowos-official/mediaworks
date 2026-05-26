-- 2026-05-26: product-files bucket を private 化 + storage.objects に RLS。
-- 既存オブジェクトは残るが、unauthenticated な public URL は機能しなくなる。
-- UI は file_url を読まないため user-facing 影響なし。

BEGIN;

-- 1) bucket を private 化
UPDATE storage.buckets SET public = false WHERE id = 'product-files';

-- 2) storage.objects RLS 有効化 (idempotent)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3) 既存ポリシーをクリア (idempotent re-run)
DROP POLICY IF EXISTS "product_files_member_read"   ON storage.objects;
DROP POLICY IF EXISTS "product_files_member_write"  ON storage.objects;
DROP POLICY IF EXISTS "product_files_member_update" ON storage.objects;
DROP POLICY IF EXISTS "product_files_admin_delete"  ON storage.objects;

-- 4) Group B (member/admin) ポリシー
CREATE POLICY "product_files_member_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'product-files' AND public.current_user_role() IN ('member','admin'));

CREATE POLICY "product_files_member_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-files' AND public.current_user_role() IN ('member','admin'));

CREATE POLICY "product_files_member_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'product-files' AND public.current_user_role() IN ('member','admin'))
  WITH CHECK (bucket_id = 'product-files' AND public.current_user_role() IN ('member','admin'));

CREATE POLICY "product_files_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'product-files' AND public.current_user_role() = 'admin');

COMMIT;
