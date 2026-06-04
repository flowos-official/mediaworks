-- 2026-06-04: compliance_references — grounding corpus for the screenplay check
-- tool. Distinct from compliance_rules (deterministic NG/allowed patterns): these
-- are authoritative reference snippets injected into the LLM judge as 根拠資料.
-- Group B RLS: read member|admin, write admin only.

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

DROP POLICY IF EXISTS "compliance_references_read"      ON compliance_references;
DROP POLICY IF EXISTS "compliance_references_admin_all" ON compliance_references;

CREATE POLICY "compliance_references_read" ON compliance_references
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "compliance_references_admin_all" ON compliance_references
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

COMMIT;
