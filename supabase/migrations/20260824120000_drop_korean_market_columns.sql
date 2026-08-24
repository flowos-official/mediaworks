-- Retire the Korean deployment's columns.
--
-- MediaWorks became Japan-only on 2026-08-24 (commit 5c5ad02): the LOTTE
-- deployment is finished, its rows are deleted, and no code reads these
-- columns any more. They were kept briefly to make the removal reversible.
--
-- NOT touched: research_results.korea_market_fit / korea_fit_score /
-- japan_export_fit_score. Those are the Japanese research report's own
-- Korea-export section, not Korean-deployment scaffolding.
--
-- Deliberately no CASCADE anywhere. If some object still depends on a column
-- being dropped, this transaction fails and rolls back rather than quietly
-- destroying that object.

BEGIN;

-- The history view selects discovery_runs.country, so it must be dropped
-- first and rebuilt below — CREATE OR REPLACE VIEW cannot change a view's
-- column list.
DROP VIEW IF EXISTS public.discovery_run_feedback_stats;

-- Dual-currency mirroring exists only to keep the two markets' price columns
-- aligned; with one market it is dead weight.
DROP TRIGGER IF EXISTS discovered_products_sync_market_price ON public.discovered_products;
DROP TRIGGER IF EXISTS historical_broadcasts_sync_market_price ON public.historical_broadcasts;
DROP TRIGGER IF EXISTS broadcast_products_sync_market_price ON public.broadcast_products;
DROP FUNCTION IF EXISTS public.sync_dual_market_price_columns();
DROP FUNCTION IF EXISTS public.sync_dual_broadcast_product_price_columns();

-- learning_state was re-keyed on (context, country) to isolate the markets'
-- feedback; it collapses back to one row per context.
ALTER TABLE public.learning_state DROP CONSTRAINT IF EXISTS learning_state_pkey;
ALTER TABLE public.learning_state ADD CONSTRAINT learning_state_pkey PRIMARY KEY (context);

ALTER TABLE public.learning_insights
  DROP CONSTRAINT IF EXISTS learning_insights_week_context_country_key;
ALTER TABLE public.learning_insights
  ADD CONSTRAINT learning_insights_week_context_key UNIQUE (week_start, context);

DROP INDEX IF EXISTS public.idx_learning_state_country_context;
DROP INDEX IF EXISTS public.idx_learning_insights_country_context;

-- Columns. Their CHECK constraints, defaults and indexes go with them.
ALTER TABLE public.broadcasts            DROP COLUMN IF EXISTS country;
ALTER TABLE public.discovery_runs        DROP COLUMN IF EXISTS country;
ALTER TABLE public.research_results      DROP COLUMN IF EXISTS country;
ALTER TABLE public.learning_state        DROP COLUMN IF EXISTS country;
ALTER TABLE public.learning_insights     DROP COLUMN IF EXISTS country;

ALTER TABLE public.historical_broadcasts
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS price_krw;

ALTER TABLE public.discovered_products
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS price_krw,
  DROP COLUMN IF EXISTS naver_product_id,
  DROP COLUMN IF EXISTS naver_cross_match;

ALTER TABLE public.broadcast_products
  DROP COLUMN IF EXISTS price_krw,
  DROP COLUMN IF EXISTS original_price_krw;

-- Same view as before, minus country.
CREATE VIEW public.discovery_run_feedback_stats
WITH (security_invoker = true) AS
SELECT
  r.id,
  r.run_at,
  r.completed_at,
  r.status,
  r.target_count,
  r.produced_count,
  r.iterations,
  r.context,
  COALESCE(p.product_count, 0) AS product_count,
  COALESCE(p.feedback_count, 0) AS feedback_count
FROM public.discovery_runs r
LEFT JOIN (
  SELECT
    session_id,
    count(*)::int AS product_count,
    count(*) FILTER (WHERE user_action IS NOT NULL)::int AS feedback_count
  FROM public.discovered_products
  WHERE session_id IS NOT NULL
  GROUP BY session_id
) p ON p.session_id = r.id;

GRANT SELECT ON public.discovery_run_feedback_stats TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
