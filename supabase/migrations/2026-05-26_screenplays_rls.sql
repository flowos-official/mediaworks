-- 2026-05-26: screenplays / screenplay_versions が Group B (member|admin) のはずだったが
-- 元のマイグレーションで ENABLE RLS + ポリシーが抜けていた。viewer ロールが
-- 直接 SELECT 可能だったので閉じる。

BEGIN;

ALTER TABLE screenplays ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenplay_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "screenplays_member_read"         ON screenplays;
DROP POLICY IF EXISTS "screenplays_member_all"          ON screenplays;
DROP POLICY IF EXISTS "screenplay_versions_member_read" ON screenplay_versions;
DROP POLICY IF EXISTS "screenplay_versions_member_all"  ON screenplay_versions;

CREATE POLICY "screenplays_member_read" ON screenplays
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "screenplays_member_all" ON screenplays
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('member','admin'))
  WITH CHECK (public.current_user_role() IN ('member','admin'));

CREATE POLICY "screenplay_versions_member_read" ON screenplay_versions
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "screenplay_versions_member_all" ON screenplay_versions
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('member','admin'))
  WITH CHECK (public.current_user_role() IN ('member','admin'));

COMMIT;
