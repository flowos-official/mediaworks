-- An on-demand product finder that ranks what is already stored.
--
-- The run is the unit of accountability. A recommendation that cannot say
-- which evidence it read is not auditable, so a run reaches `completed` only
-- together with a knowledge_snapshot_id — the CHECK below makes that an
-- invariant of the table rather than a convention in the service.
--
-- `mode` is pinned to 'stored_only' and widened later, deliberately: the
-- supplemental-research path (20260829160000) is the ONLY thing allowed to
-- call an external provider, and it has to alter this constraint to exist.
-- That makes "did anything reach the internet" a schema-level question.
--
-- expected_contribution_profit_jpy is nullable on purpose. Profit stays
-- unknown unless internal data supports it; a competitor's sales claim is not
-- our margin, and writing 0 for "we don't know" would make it look measured.

BEGIN;

CREATE TABLE product_recommendation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'stored_only' CHECK (mode = 'stored_only'),
  query_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  algorithm_version text NOT NULL,
  knowledge_snapshot_id uuid REFERENCES knowledge_snapshots(id) ON DELETE RESTRICT,
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'completed') = (knowledge_snapshot_id IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE product_recommendation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES product_recommendation_runs(id) ON DELETE CASCADE,
  canonical_product_id uuid NOT NULL REFERENCES canonical_products(id) ON DELETE RESTRICT,
  rank integer NOT NULL CHECK (rank > 0),
  opportunity_index numeric(6,5) NOT NULL CHECK (opportunity_index BETWEEN 0 AND 1),
  expected_contribution_profit_jpy numeric,
  axes jsonb NOT NULL,
  confidence jsonb NOT NULL,
  reasons jsonb NOT NULL,
  risks jsonb NOT NULL,
  missing_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, rank),
  UNIQUE (run_id, canonical_product_id)
);

CREATE TABLE product_recommendation_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES product_recommendation_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('interested','excluded')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, user_id)
);

CREATE INDEX product_recommendation_runs_user_idx
  ON product_recommendation_runs(created_by, created_at DESC);
CREATE INDEX product_recommendation_items_run_idx
  ON product_recommendation_items(run_id, rank);

ALTER TABLE product_recommendation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_recommendation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_recommendation_decisions ENABLE ROW LEVEL SECURITY;

-- Owner-scoped AND member|admin.
--
-- Ownership alone is what the plan specified, and it is not enough. These rows
-- are derived from canonical_products and evidence_items, both member|admin
-- since 20260830100000 — a migration that exists precisely because the last
-- set of derived tables shipped wider than their sources. A viewer who came to
-- own a run would read member-only data through it. The rule that migration
-- records is the one applied here: inherit the strictest source grade, and if
-- a wider grade is wanted, narrow the derivation instead.
--
-- Writes are service-role only, like the rest of the intelligence layer: the
-- run service is the sole writer and it does not run as an end user.
CREATE POLICY product_recommendation_runs_owner_read ON product_recommendation_runs
  FOR SELECT TO authenticated
  USING (created_by = auth.uid() AND public.current_user_role() IN ('member','admin'));

CREATE POLICY product_recommendation_items_owner_read ON product_recommendation_items
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() IN ('member','admin')
    AND EXISTS (
      SELECT 1 FROM product_recommendation_runs r
      WHERE r.id = run_id AND r.created_by = auth.uid()
    )
  );

CREATE POLICY product_recommendation_decisions_owner_read ON product_recommendation_decisions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.current_user_role() IN ('member','admin'));

NOTIFY pgrst, 'reload schema';

COMMIT;
