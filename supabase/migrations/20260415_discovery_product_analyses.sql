CREATE TABLE IF NOT EXISTS discovery_product_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  source_url text NOT NULL,
  product_name text NOT NULL,
  sales_strategy jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX idx_dpa_session_url
  ON discovery_product_analyses (session_id, source_url);
