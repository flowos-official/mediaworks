CREATE TABLE IF NOT EXISTS discovery_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context text NOT NULL DEFAULT 'home_shopping',
  category text,
  target_market text,
  price_range text,
  user_goal text,
  discovery_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
