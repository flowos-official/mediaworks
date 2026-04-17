-- Product Discovery Redesign — Phase 1 schema
-- Ref: docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md §7

-- 1. discovery_sessions ----------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  target_count int NOT NULL DEFAULT 30,
  produced_count int NOT NULL DEFAULT 0,
  category_plan jsonb,
  exploration_ratio numeric(3,2),
  iterations int NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX IF NOT EXISTS idx_discovery_sessions_run_at
  ON discovery_sessions (run_at DESC);

-- 2. discovered_products ---------------------------------------------------
CREATE TABLE IF NOT EXISTS discovered_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES discovery_sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  name text NOT NULL,
  name_normalized text NOT NULL,
  thumbnail_url text,
  product_url text NOT NULL,
  price_jpy int,
  category text,
  source text NOT NULL CHECK (source IN ('rakuten','brave','other')),
  rakuten_item_code text,
  review_count int,
  review_avg numeric(2,1),
  seller_name text,
  stock_status text,

  tv_fit_score int CHECK (tv_fit_score BETWEEN 0 AND 100),
  tv_fit_reason text,
  broadcast_tag text CHECK (broadcast_tag IN ('broadcast_confirmed','broadcast_likely','unknown')),
  broadcast_sources jsonb,

  track text NOT NULL CHECK (track IN ('tv_proven','exploration')),
  is_tv_applicable boolean NOT NULL DEFAULT true,
  is_live_applicable boolean NOT NULL DEFAULT false,

  enrichment_status text NOT NULL DEFAULT 'idle'
    CHECK (enrichment_status IN ('idle','queued','running','completed','failed')),
  enrichment_started_at timestamptz,
  enrichment_completed_at timestamptz,
  c_package jsonb,
  enrichment_error text,

  user_action text CHECK (user_action IN ('sourced','interested','rejected','duplicate')),
  action_reason text,
  action_at timestamptz,

  UNIQUE (session_id, product_url)
);
CREATE INDEX IF NOT EXISTS idx_dp_session_id ON discovered_products (session_id);
CREATE INDEX IF NOT EXISTS idx_dp_created_at ON discovered_products (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dp_user_action ON discovered_products (user_action);
CREATE INDEX IF NOT EXISTS idx_dp_name_normalized ON discovered_products (name_normalized);
CREATE INDEX IF NOT EXISTS idx_dp_rakuten_item_code
  ON discovered_products (rakuten_item_code)
  WHERE rakuten_item_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dp_enrichment_status ON discovered_products (enrichment_status);

-- 3. product_feedback ------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_product_id uuid NOT NULL REFERENCES discovered_products(id) ON DELETE CASCADE,
  action text NOT NULL
    CHECK (action IN ('sourced','interested','rejected','duplicate','deep_dive')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pf_created_at ON product_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pf_action ON product_feedback (action);
CREATE INDEX IF NOT EXISTS idx_pf_product ON product_feedback (discovered_product_id);

-- 4. learning_state (singleton) -------------------------------------------
CREATE TABLE IF NOT EXISTS learning_state (
  id int PRIMARY KEY CHECK (id = 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  exploration_ratio numeric(3,2) NOT NULL DEFAULT 0.47,
  category_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejected_seeds jsonb NOT NULL
    DEFAULT '{"urls":[],"brands":[],"terms":[]}'::jsonb,
  recent_rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  feedback_sample_size int NOT NULL DEFAULT 0,
  is_cold_start boolean NOT NULL DEFAULT true
);
INSERT INTO learning_state (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;

-- 5. learning_insights -----------------------------------------------------
CREATE TABLE IF NOT EXISTS learning_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sourced_count int,
  rejected_count int,
  top_rejection_reasons jsonb,
  sourced_product_patterns text,
  exploration_wins text,
  next_week_suggestions text,
  UNIQUE (week_start)
);
CREATE INDEX IF NOT EXISTS idx_li_week_start ON learning_insights (week_start DESC);
