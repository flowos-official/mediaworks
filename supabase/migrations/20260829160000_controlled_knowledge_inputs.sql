-- The two ways new information is allowed to enter the ledger, and the one way
-- it is allowed to leave.
--
-- Supplemental research is the ONLY path that may call an external provider.
-- Until now `product_recommendation_runs.mode` was pinned to 'stored_only' by a
-- CHECK, which made "did anything reach the internet" a question the schema
-- answered. Widening it is therefore this migration's most consequential line,
-- and it widens to exactly two values — not to a free text column.
--
-- Evidence is REVOKED, never deleted. A deleted row would break the RESTRICT
-- from knowledge_snapshot_items, and — worse — it would silently rewrite what a
-- past recommendation is recorded as having read. A rollback has to mean "stop
-- using this", not "it never happened".
--
-- The gap enum is closed at the database. A caller cannot ask for
-- 'actual_competitor_revenue': we have no way to know a competitor's revenue,
-- and a column that accepted the request would eventually hold an answer.

BEGIN;

-- 1) Supplemented recommendations become expressible.
ALTER TABLE product_recommendation_runs
  DROP CONSTRAINT IF EXISTS product_recommendation_runs_mode_check;
ALTER TABLE product_recommendation_runs
  ADD CONSTRAINT product_recommendation_runs_mode_check
  CHECK (mode in ('stored_only','supplemented'));

-- 2) Evidence gains provenance for imports and a revocation record.
ALTER TABLE evidence_items
  ADD COLUMN import_batch_id uuid REFERENCES import_batches(id) ON DELETE RESTRICT,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN revocation_reason text;

-- A revocation without a time is not a revocation, and one without a reason is
-- unreviewable six weeks later.
ALTER TABLE evidence_items
  ADD CONSTRAINT evidence_revocation_complete
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL));

-- Every consumer reads active evidence for one subject. Partial on
-- revoked_at IS NULL so a large rollback does not make every later read slower.
CREATE INDEX evidence_active_subject_idx
  ON evidence_items(subject_type, subject_id, predicate, observed_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX evidence_import_batch_idx
  ON evidence_items(import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- 3) The audit record for one explicit act of external research.
CREATE TABLE supplemental_research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_run_id uuid NOT NULL REFERENCES product_recommendation_runs(id) ON DELETE RESTRICT,
  canonical_product_id uuid NOT NULL REFERENCES canonical_products(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  requested_gaps text[] NOT NULL,
  status text NOT NULL CHECK (status in ('queued','running','completed','partial','failed')),
  -- What the recommendation rested on BEFORE. Kept so the two can be compared:
  -- "this is what changed when we went and looked" is the whole value here.
  prior_knowledge_snapshot_id uuid NOT NULL REFERENCES knowledge_snapshots(id) ON DELETE RESTRICT,
  result_knowledge_snapshot_id uuid REFERENCES knowledge_snapshots(id) ON DELETE RESTRICT,
  result_recommendation_run_id uuid REFERENCES product_recommendation_runs(id) ON DELETE RESTRICT,
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (cardinality(requested_gaps) > 0),
  CHECK (requested_gaps <@ array['official_product_facts','current_price','seller_sales_claim','review_signal','ranking_signal']::text[])
);

CREATE INDEX supplemental_runs_owner_idx ON supplemental_research_runs(created_by, created_at DESC);
CREATE INDEX supplemental_runs_source_idx ON supplemental_research_runs(recommendation_run_id);

ALTER TABLE supplemental_research_runs ENABLE ROW LEVEL SECURITY;

-- Owner AND member|admin, for the reason 20260829141000 records: these rows
-- derive from canonical_products and evidence_items, both member|admin since
-- 20260830100000. Ownership alone would let a viewer who came to own a run read
-- member-only data through it.
CREATE POLICY supplemental_runs_owner_read ON supplemental_research_runs
  FOR SELECT TO authenticated
  USING (created_by = auth.uid() AND public.current_user_role() IN ('member','admin'));

-- The run is started BY a user, from a request, so it needs owner-scoped
-- writes — the same shape the product finder needed in 20260829141000. No
-- DELETE: this is the record that external providers were called on someone's
-- explicit instruction.
CREATE POLICY supplemental_runs_owner_insert ON supplemental_research_runs
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.current_user_role() IN ('member','admin'));

CREATE POLICY supplemental_runs_owner_update ON supplemental_research_runs
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() AND public.current_user_role() IN ('member','admin'))
  WITH CHECK (created_by = auth.uid());

-- 4) import_batches / import_rows gain the owner writes their first writer
-- needs. They shipped in 20260829131000 with read policies only, on the
-- assumption that every writer would be service-role; the import flow is
-- user-initiated, so that assumption does not hold here.
CREATE POLICY import_batches_owner_insert ON import_batches
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.current_user_role() IN ('member','admin'));

CREATE POLICY import_batches_owner_update ON import_batches
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() AND public.current_user_role() IN ('member','admin'))
  WITH CHECK (created_by = auth.uid());

NOTIFY pgrst, 'reload schema';

COMMIT;
