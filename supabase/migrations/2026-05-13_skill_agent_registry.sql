-- Skill & Agent Registry — Step 1 of migration
-- Ref: docs/superpowers/specs/2026-05-13-skill-agent-registry-design.md §5

-- ============================================================================
-- 1. agents — stable top-level orchestrator identity
-- ============================================================================
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  display_name text NOT NULL,
  description text,
  active_pipeline_id uuid,                   -- FK added after agent_pipelines below
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. skills — stable per-skill identity, version pointer separate
-- ============================================================================
CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  display_name text NOT NULL,
  category text CHECK (category IN ('analysis','curation','planning','enrichment','generation')),
  active_version_id uuid,                    -- FK added after skill_versions below
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 3. skill_versions — IMMUTABLE published copy
-- ============================================================================
CREATE TABLE IF NOT EXISTS skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES skills(id),
  git_sha text NOT NULL,
  version_label text NOT NULL,
  prompt_template text NOT NULL,
  output_schema jsonb NOT NULL,              -- JSON Schema (converted from Zod)
  model text NOT NULL,                       -- e.g. 'gemini-3-flash-preview'
  provider text NOT NULL DEFAULT 'google'
    CHECK (provider IN ('google','anthropic')),
  generation_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  validators jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_by text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, git_sha)
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_id ON skill_versions (skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_versions_published_at ON skill_versions (published_at DESC);

ALTER TABLE skills
  DROP CONSTRAINT IF EXISTS fk_skills_active_version,
  ADD CONSTRAINT fk_skills_active_version
    FOREIGN KEY (active_version_id) REFERENCES skill_versions(id);

-- Immutability trigger — applied to both skill_versions and agent_pipelines.
-- A "fix" is always a new row + active-pointer update, never UPDATE/DELETE.
CREATE OR REPLACE FUNCTION prevent_registry_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registry version rows are immutable; insert a new version instead';
END $$;

DROP TRIGGER IF EXISTS no_mutate_skill_versions ON skill_versions;
CREATE TRIGGER no_mutate_skill_versions
  BEFORE UPDATE OR DELETE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_registry_version_mutation();

-- ============================================================================
-- 4. agent_pipelines — declarative DAG, immutable per version
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  git_sha text NOT NULL,
  version_label text NOT NULL,
  dag jsonb NOT NULL,                        -- [{skill_slug, requires:[], optional, retry_policy}]
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, git_sha)
);
CREATE INDEX IF NOT EXISTS idx_agent_pipelines_agent_id ON agent_pipelines (agent_id);

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS fk_agents_active_pipeline,
  ADD CONSTRAINT fk_agents_active_pipeline
    FOREIGN KEY (active_pipeline_id) REFERENCES agent_pipelines(id);

DROP TRIGGER IF EXISTS no_mutate_agent_pipelines ON agent_pipelines;
CREATE TRIGGER no_mutate_agent_pipelines
  BEFORE UPDATE OR DELETE ON agent_pipelines
  FOR EACH ROW EXECUTE FUNCTION prevent_registry_version_mutation();

-- ============================================================================
-- 5. agent_runs — one row per pipeline execution
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  pipeline_version_id uuid NOT NULL REFERENCES agent_pipelines(id),
  workflow_run_id text,                      -- Vercel WDK run id
  user_id uuid,
  input jsonb NOT NULL,
  status text NOT NULL
    CHECK (status IN ('running','completed','failed','cancelled')),
  total_cost_usd numeric(10,6),
  total_tokens_in int,
  total_tokens_out int,
  duration_ms int,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started
  ON agent_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_running
  ON agent_runs (status) WHERE status = 'running';

-- ============================================================================
-- 6. skill_runs — one row per skill call, partitioned monthly by started_at
-- ============================================================================
CREATE TABLE IF NOT EXISTS skill_runs (
  id uuid DEFAULT gen_random_uuid(),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id),
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),
  step_name text NOT NULL,
  input_hash text NOT NULL,
  input_jsonb jsonb,
  output_jsonb jsonb,
  tokens_in int,
  tokens_out int,
  cost_usd numeric(10,6),
  duration_ms int,
  validator_violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL
    CHECK (status IN ('completed','failed')),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE INDEX IF NOT EXISTS idx_skill_runs_version_started
  ON skill_runs (skill_version_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_runs_agent_run
  ON skill_runs (agent_run_id);
CREATE INDEX IF NOT EXISTS idx_skill_runs_input_hash
  ON skill_runs (input_hash);

-- Seed initial partitions; later partitions are created by a nightly job.
CREATE TABLE IF NOT EXISTS skill_runs_2026_05 PARTITION OF skill_runs
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS skill_runs_2026_06 PARTITION OF skill_runs
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS skill_runs_2026_07 PARTITION OF skill_runs
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- ============================================================================
-- 7. RLS — registry read for authenticated, write for service_role only
-- ============================================================================
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS registry_read ON agents;
CREATE POLICY registry_read ON agents FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS registry_read ON skills;
CREATE POLICY registry_read ON skills FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS registry_read ON skill_versions;
CREATE POLICY registry_read ON skill_versions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS registry_read ON agent_pipelines;
CREATE POLICY registry_read ON agent_pipelines FOR SELECT TO authenticated USING (true);

-- Runs: single-tenant internal tool, all authenticated users may read for now.
DROP POLICY IF EXISTS runs_read ON agent_runs;
CREATE POLICY runs_read ON agent_runs FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS runs_read ON skill_runs;
CREATE POLICY runs_read ON skill_runs FOR SELECT TO authenticated USING (true);

-- All writes go through service_role (server-only). No INSERT/UPDATE policies
-- for authenticated, so client-side writes are blocked by default.
