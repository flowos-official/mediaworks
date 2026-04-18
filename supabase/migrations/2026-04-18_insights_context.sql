-- Phase 6: add context column to learning_insights with compound UNIQUE

ALTER TABLE learning_insights
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));

ALTER TABLE learning_insights DROP CONSTRAINT IF EXISTS learning_insights_week_start_key;
ALTER TABLE learning_insights ADD CONSTRAINT learning_insights_week_context_key
  UNIQUE (week_start, context);

CREATE INDEX IF NOT EXISTS idx_learning_insights_context
  ON learning_insights (context, week_start DESC);
