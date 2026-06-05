-- 2026-06-04 (corrective): tighten compliance_references RLS so admins cannot
-- DELETE (Codex audit #1). DBs created from the original migration got a single
-- `compliance_references_admin_all` FOR ALL policy, which permitted UPDATE *and
-- DELETE* for any admin JWT — letting an admin physically remove a reference that
-- a past compliance result depends on, making that result unreproducible.
--
-- This replaces FOR ALL with explicit INSERT + UPDATE policies and NO delete
-- policy, so RLS denies DELETE to every JWT (admins included). Physical purge, if
-- ever needed, is a service-role migration outside user RLS. Idempotent: safe to
-- run whether the DB has the old FOR ALL policy or the new split policies.

BEGIN;

DROP POLICY IF EXISTS "compliance_references_admin_all"    ON compliance_references;
DROP POLICY IF EXISTS "compliance_references_admin_insert" ON compliance_references;
DROP POLICY IF EXISTS "compliance_references_admin_update" ON compliance_references;

CREATE POLICY "compliance_references_admin_insert" ON compliance_references
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

CREATE POLICY "compliance_references_admin_update" ON compliance_references
  FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

COMMIT;
