-- Observability for the 8-channel daily-historical-broadcasts cron.
-- One row per cron execution, with per-channel breakdown in `channels` jsonb.
-- Treat as the gate before adding category filtering or AI competitive
-- analysis downstream — confirms data ingest is healthy.

CREATE TABLE IF NOT EXISTS historical_crawl_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at          timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  jst_date        date NOT NULL,
  status          text NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  total_rows      int NOT NULL DEFAULT 0,
  upserted        int NOT NULL DEFAULT 0,
  skipped_dup     int NOT NULL DEFAULT 0,
  channels        jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms     int,
  error           text
);

CREATE INDEX IF NOT EXISTS idx_hcr_run_at ON historical_crawl_runs (run_at DESC);
CREATE INDEX IF NOT EXISTS idx_hcr_jst_date ON historical_crawl_runs (jst_date DESC);

ALTER TABLE historical_crawl_runs ENABLE ROW LEVEL SECURITY;

-- Admin-only: this is operational telemetry, not business data.
DROP POLICY IF EXISTS admin_all ON historical_crawl_runs;
CREATE POLICY admin_all ON historical_crawl_runs
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );
