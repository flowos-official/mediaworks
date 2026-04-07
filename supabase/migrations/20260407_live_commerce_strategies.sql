create table live_commerce_strategies (
  id uuid primary key default gen_random_uuid(),
  user_goal text,
  target_platforms text[],
  market_research jsonb,
  platform_analysis jsonb,
  content_strategy jsonb,
  execution_plan jsonb,
  risk_analysis jsonb,
  search_sources jsonb,
  created_at timestamptz default now()
);

alter table live_commerce_strategies enable row level security;
