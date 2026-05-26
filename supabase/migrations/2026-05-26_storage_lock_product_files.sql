-- 2026-05-26: product-files bucket を private 化。
-- 既存オブジェクトは残るが、unauthenticated な public URL は機能しなくなる。
-- UI は file_url を読まないため user-facing 影響なし。
--
-- 注意: storage.objects への RLS 有効化 + ポリシー作成は Supabase SQL editor で
-- "ERROR: 42501: must be owner of table objects" を返すため、本 migration には
-- 含めない。bucket private 化だけで Phase 4 の High-priority 露出 (URL guess) は
-- 閉じる。member/admin が supabase-js client から storage 経由で読/쓸 필요가
-- 생기면 Supabase Dashboard > Storage > Policies UI 에서 다음을 추가:
--
--   product_files_member_read (SELECT, bucket_id='product-files', role member|admin)
--   product_files_member_write (INSERT, bucket_id='product-files', role member|admin)
--   product_files_member_update (UPDATE, bucket_id='product-files', role member|admin)
--   product_files_admin_delete (DELETE, bucket_id='product-files', role admin)
--
-- 현재 모든 storage 작업은 server-side getServiceClient() (service-role) 를 통해
-- 일어나므로 policies 가 없어도 동작에 지장 없음 (service-role 은 RLS bypass).

BEGIN;

UPDATE storage.buckets SET public = false WHERE id = 'product-files';

COMMIT;
