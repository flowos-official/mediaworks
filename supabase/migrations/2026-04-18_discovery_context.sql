-- Add context column to support home_shopping vs live_commerce split
-- Ref: Phase 3.5 plan

ALTER TABLE discovery_runs
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));

CREATE INDEX IF NOT EXISTS idx_discovery_runs_context
  ON discovery_runs (context, run_at DESC);

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));

CREATE INDEX IF NOT EXISTS idx_discovered_products_context
  ON discovered_products (context, created_at DESC);
