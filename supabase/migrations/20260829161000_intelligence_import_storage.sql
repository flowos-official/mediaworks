-- Where an operator's own sales spreadsheet lives.
--
-- These are the most sensitive files this system holds: internal cost, fees and
-- margin, uploaded by a named person. A public bucket would make a company's
-- cost book reachable by guessing a URL, which is exactly the exposure
-- 2026-05-26_storage_lock_product_files.sql was written to close for uploads.
--
-- Owner scoping is by the FIRST path segment. The upload route writes
-- `${auth.uid()}/${batchId}/${safeName}`, so `storage.foldername(name)[1]` is
-- the owner, and a policy keyed on it cannot be defeated by knowing another
-- object's name.
--
-- Uploads themselves go through the server route with service credentials, so
-- no INSERT policy is granted: a client that could write here directly could
-- write under someone else's folder prefix by choosing the path.
--
-- NOTE: on this project, `ALTER TABLE storage.objects ENABLE ROW LEVEL
-- SECURITY` fails with "must be owner of table objects" (see
-- 2026-05-26_storage_lock_product_files.sql). RLS is already enabled on
-- storage.objects by Supabase itself, so only the policies are created here.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'intelligence-imports',
  'intelligence-imports',
  false,
  15728640,
  ARRAY[
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

DROP POLICY IF EXISTS intelligence_imports_owner_read ON storage.objects;
CREATE POLICY intelligence_imports_owner_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'intelligence-imports'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.current_user_role() IN ('member','admin')
  );

-- Deleting one's own upload is reasonable; deleting the batch's audit rows is
-- not, and those live in import_batches / import_rows where there is no DELETE
-- policy at all.
DROP POLICY IF EXISTS intelligence_imports_owner_delete ON storage.objects;
CREATE POLICY intelligence_imports_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'intelligence-imports'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.current_user_role() IN ('member','admin')
  );

COMMIT;
