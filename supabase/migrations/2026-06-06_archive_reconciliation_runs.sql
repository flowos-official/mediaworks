-- 2026-06-06: archive coverage reconciliation run log (admin observability).
-- Applied manually (no supabase CLI in repo).
BEGIN;

CREATE TABLE IF NOT EXISTS archive_reconciliation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at          timestamptz NOT NULL,
  window_from     date NOT NULL,
  window_to       date NOT NULL,
  channels        text[] NOT NULL DEFAULT '{}',
  expected_total  int NOT NULL DEFAULT 0,
  archived_total  int NOT NULL DEFAULT 0,
  coverage_pct    numeric(5,2) NOT NULL DEFAULT 0,
  healed          int NOT NULL DEFAULT 0,
  unhealable      int NOT NULL DEFAULT 0,
  no_source       int NOT NULL DEFAULT 0,
  probed          int NOT NULL DEFAULT 0,
  coverage_by_day jsonb NOT NULL DEFAULT '[]'::jsonb,
  gaps            jsonb NOT NULL DEFAULT '[]'::jsonb,
  alerted         boolean NOT NULL DEFAULT false,
  alert_error     text,
  duration_ms     int,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archive_reconciliation_runs_ran_at_idx
  ON archive_reconciliation_runs (ran_at DESC);

ALTER TABLE archive_reconciliation_runs ENABLE ROW LEVEL SECURITY;

-- Group B (internal/admin): admins may read; writes only via service role (cron),
-- which bypasses RLS. Mirrors historical_crawl_runs.
DROP POLICY IF EXISTS arr_select_admin ON archive_reconciliation_runs;
CREATE POLICY arr_select_admin ON archive_reconciliation_runs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

COMMIT;
