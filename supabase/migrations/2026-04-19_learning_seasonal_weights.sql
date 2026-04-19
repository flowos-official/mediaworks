-- Phase 5: per-category monthly seasonality factors for discovery planner.
-- Structure: { "<category>": { "1": <factor>, "2": <factor>, ..., "12": <factor> } }
-- factor = monthly_revenue / (annual_revenue / 12). 1.0 = average, >1.0 = hot season.
-- Clipped to [0.3, 2.0] during computation to avoid extreme signals.

ALTER TABLE learning_state
  ADD COLUMN IF NOT EXISTS category_seasonal_weights jsonb NOT NULL DEFAULT '{}'::jsonb;
