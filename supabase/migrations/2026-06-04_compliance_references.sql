-- 2026-06-04: compliance_references — grounding corpus for the screenplay check
-- tool. Distinct from compliance_rules (deterministic NG/allowed patterns): these
-- are authoritative reference snippets injected into the LLM judge as 根拠資料.
-- RLS: read member|admin; admin may INSERT + UPDATE but NOT DELETE — references
-- are evidence for past compliance results, so physical removal (which would make
-- those results unreproducible) is reserved for service-role migrations, never an
-- admin JWT. Deactivation is soft via UPDATE active=false. (Codex audit #1)
-- NOTE: DBs created before 2026-06-04 got a FOR ALL admin policy; the corrective
-- migration 2026-06-04_compliance_references_rls_no_delete.sql converges them.

BEGIN;

CREATE TABLE IF NOT EXISTS compliance_references (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  law            text NOT NULL CHECK (law IN ('yakkiho','keihyo','kenzo','other')),
  category_scope text[] NOT NULL DEFAULT '{}',
  topic          text NOT NULL,
  body           text NOT NULL,
  keywords       text[] NOT NULL DEFAULT '{}',
  citation       text NOT NULL DEFAULT '',
  source_url     text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (law, topic)
);

CREATE INDEX IF NOT EXISTS compliance_references_active_idx
  ON compliance_references (active) WHERE active;

ALTER TABLE compliance_references ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "compliance_references_read"          ON compliance_references;
DROP POLICY IF EXISTS "compliance_references_admin_all"     ON compliance_references;
DROP POLICY IF EXISTS "compliance_references_admin_insert"  ON compliance_references;
DROP POLICY IF EXISTS "compliance_references_admin_update"  ON compliance_references;

CREATE POLICY "compliance_references_read" ON compliance_references
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

-- INSERT + UPDATE only. No DELETE policy → RLS denies DELETE to every JWT
-- (admin included); only the service role (RLS-bypassing) can physically purge.
CREATE POLICY "compliance_references_admin_insert" ON compliance_references
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

CREATE POLICY "compliance_references_admin_update" ON compliance_references
  FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

COMMIT;
