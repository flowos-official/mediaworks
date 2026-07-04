-- 2026-07-04: multi-tenant scoping for the screenplay compliance corpus.
-- Tokyo-TV 考査 rules/refs must not pollute mediaworks' own checks and vice
-- versa. `tenant` is a DATA filter (not a security boundary between our own
-- roles) — RLS role policies are unchanged. Existing rows default to
-- 'mediaworks'. UNIQUE keys gain `tenant` so the same (law,pattern)/(law,topic)
-- may exist per tenant.

BEGIN;

ALTER TABLE compliance_rules      ADD COLUMN IF NOT EXISTS tenant text NOT NULL DEFAULT 'mediaworks';
ALTER TABLE compliance_references ADD COLUMN IF NOT EXISTS tenant text NOT NULL DEFAULT 'mediaworks';

ALTER TABLE compliance_rules      DROP CONSTRAINT IF EXISTS compliance_rules_law_pattern_key;
ALTER TABLE compliance_rules      ADD  CONSTRAINT compliance_rules_tenant_law_pattern_key UNIQUE (tenant, law, pattern);

ALTER TABLE compliance_references DROP CONSTRAINT IF EXISTS compliance_references_law_topic_key;
ALTER TABLE compliance_references ADD  CONSTRAINT compliance_references_tenant_law_topic_key UNIQUE (tenant, law, topic);

CREATE INDEX IF NOT EXISTS compliance_rules_tenant_active_idx      ON compliance_rules (tenant, active)      WHERE active;
CREATE INDEX IF NOT EXISTS compliance_references_tenant_active_idx ON compliance_references (tenant, active) WHERE active;

COMMIT;
