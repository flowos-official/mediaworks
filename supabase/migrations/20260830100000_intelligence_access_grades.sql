-- The intelligence layer inherits the grade of its strictest source.
--
-- 20260829130000 and 20260829131000 shipped every read policy as
-- `to authenticated using (true)`, which is Group A — viewer included. But the
-- rows these tables hold are derived from Group B sources:
--
--   * lib/intelligence/backfill.ts::mapDiscoveredProductEvidence copies
--     discovered_products name / product_url / price_jpy / review_count into
--     evidence_items. discovered_products is member|admin
--     (2026-05-13_auth_rls_tight.sql).
--   * mapBroadcastAnalysisEvidence copies broadcast_speech_analyses act
--     timecodes and enum counts. That table is member|admin
--     (20260825090000_broadcast_speech_analyses.sql).
--   * lib/intelligence/insights.ts already defines gross_profit_jpy,
--     profit_per_unit_jpy and gross_margin_pct predicates, so the pending
--     internal-Excel work would put our own margin behind the same policy.
--
-- No viewer or member account existed when this was found (profiles held four
-- admins), so nothing leaked. The grade is corrected before either role is
-- created, not after.
--
-- The rule this encodes, for the next derived table: inherit the strictest
-- source grade. If a wider grade is wanted, narrow the derivation rather than
-- widening the policy.
--
-- Writes stay service-role-only across all ten tables. That is deliberate and
-- not an omission: the backfill, the insight refresh and the cron recorders are
-- the only writers, and none of them runs as an end user.

BEGIN;

-- The original policy on data_pipeline_runs was named for the table's old
-- working name, so it is not covered by the generated name below.
DROP POLICY IF EXISTS pipeline_runs_read ON public.data_pipeline_runs;

-- 1) Derived observation tables — member|admin, matching their sources.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'canonical_products','product_source_links','evidence_items',
    'insight_snapshots','insight_snapshot_evidence','data_pipeline_runs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
         USING (public.current_user_role() IN (''member'',''admin''))',
      t || '_read', t);
  END LOOP;
END $$;

-- 2) data_pipeline_runs.error_summary holds up to 1000 characters of raw
--    err.message from Gemini / S3 / Brave / undici — text we do not author and
--    cannot vet. error_code is ours and is safe to render, so the UI uses that
--    and this column stops at the database.
--
--    A column privilege survives someone widening a select list later; leaving
--    the column out of one query does not. Note the table-level grant has to go
--    first: in Postgres a table-level SELECT outranks a column-level REVOKE, so
--    revoking the single column on its own would be a silent no-op.
--
--    service_role holds its own grants and is unaffected, which is what lets
--    the crons keep writing the column and an admin still read it out of band.
REVOKE SELECT ON public.data_pipeline_runs FROM authenticated;
GRANT SELECT (
  id, source_type, job_type, external_run_id, status, cursor_json,
  target_scope, counts, started_at, heartbeat_at, finished_at, error_code
) ON public.data_pipeline_runs TO authenticated;

-- 3) knowledge_snapshots — team-shared, not owner-scoped.
--
-- `created_by` is nullable and `on delete set null`, so owner-scoped reads meant
-- (a) a cron-created snapshot was readable by nobody and (b) a departing
-- profile silently orphaned every snapshot that person made. The design spec
-- §7.4 requires reopening a recommendation to explain it from its stored
-- snapshot, which owner-scoping cannot satisfy. product_selections is the
-- precedent: team-shared operator state with an append-only event log.
DROP POLICY IF EXISTS knowledge_snapshots_read ON public.knowledge_snapshots;
CREATE POLICY knowledge_snapshots_read ON public.knowledge_snapshots
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

-- The EXISTS correlation goes with it: the parent is no longer owner-scoped, so
-- the subquery only bought a per-row check.
DROP POLICY IF EXISTS knowledge_snapshot_items_read ON public.knowledge_snapshot_items;
CREATE POLICY knowledge_snapshot_items_read ON public.knowledge_snapshot_items
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

-- 4) import_batches / import_rows stay owner-scoped — raw_json is the most
--    sensitive verbatim content in this set — but gain an admin escape. Without
--    it an admin cannot see the broken file a member uploaded, which is the one
--    support case these tables exist to serve.
DROP POLICY IF EXISTS import_batches_owner_read ON public.import_batches;
CREATE POLICY import_batches_owner_read ON public.import_batches
  FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR public.current_user_role() = 'admin');

DROP POLICY IF EXISTS import_rows_owner_read ON public.import_rows;
CREATE POLICY import_rows_owner_read ON public.import_rows
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.import_batches b
      WHERE b.id = import_batch_id AND b.created_by = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
