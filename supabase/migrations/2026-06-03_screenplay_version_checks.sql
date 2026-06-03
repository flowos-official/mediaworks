-- 2026-06-03: screenplay_version_checks — append-only results of the screenplay
-- check tool, one+ per screenplay_versions row. Group B RLS (member|admin read +
-- insert; no update/delete — immutable audit of each check run).

BEGIN;

CREATE TABLE IF NOT EXISTS screenplay_version_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      uuid NOT NULL REFERENCES screenplay_versions(id) ON DELETE CASCADE,
  overall_score   int  NOT NULL DEFAULT 0 CHECK (overall_score BETWEEN 0 AND 100),
  result          jsonb NOT NULL,           -- { legal: Finding[], facts: Finding[], quality: Finding[] }
  lexicon_version text NOT NULL DEFAULT '',
  is_auto         boolean NOT NULL DEFAULT false,
  created_by      uuid,                      -- null for cron/auto
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS svc_version_created_idx
  ON screenplay_version_checks (version_id, created_at DESC);

ALTER TABLE screenplay_version_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "svc_member_read"   ON screenplay_version_checks;
DROP POLICY IF EXISTS "svc_member_insert" ON screenplay_version_checks;

CREATE POLICY "svc_member_read" ON screenplay_version_checks
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "svc_member_insert" ON screenplay_version_checks
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() IN ('member','admin'));

COMMIT;
