-- TV channel recommendation source: tier-1 priority signal for discovery.
-- tv_channel_source: comma-joined alphabetically-sorted slugs (e.g. "qvc,shopch"); NULL when none.
-- tv_tier: generated 0/1 boolean-shaped key so ORDER BY produces "TV first, then others".

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS tv_channel_source text,
  ADD COLUMN IF NOT EXISTS tv_tier int
    GENERATED ALWAYS AS (CASE WHEN tv_channel_source IS NULL THEN 1 ELSE 0 END) STORED;

CREATE INDEX IF NOT EXISTS discovered_products_tier_idx
  ON discovered_products (session_id, tv_tier ASC, tv_fit_score DESC);
