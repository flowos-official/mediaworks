-- Persist per-candidate score_breakdown so the UI can surface what's driving
-- the tv_fit_score (review/category/trend/price/purchase components).
-- The breakdown is computed by Gemini in lib/discovery/curate.ts.

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS score_breakdown jsonb;
