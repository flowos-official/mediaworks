-- MD Strategy Results Table
-- Run this in Supabase Dashboard > SQL Editor

CREATE TABLE IF NOT EXISTS md_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_goal text,
  category text,
  target_market text,
  price_range text,
  product_selection jsonb,
  channel_strategy jsonb,
  pricing_margin jsonb,
  marketing_execution jsonb,
  financial_projection jsonb,
  risk_contingency jsonb,
  created_at timestamptz DEFAULT now()
);

-- Index for recent strategies lookup
CREATE INDEX IF NOT EXISTS idx_md_strategies_created_at ON md_strategies (created_at DESC);
