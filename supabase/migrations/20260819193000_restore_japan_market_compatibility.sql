-- Restore the Japanese application contract without removing the Korean
-- columns that coexist in the shared database.  All changes are additive or
-- idempotent; existing JP/KR rows are preserved.

BEGIN;

-- Product-discovery compatibility -----------------------------------------
ALTER TABLE public.discovered_products
  ADD COLUMN IF NOT EXISTS price_jpy int,
  ADD COLUMN IF NOT EXISTS rakuten_item_code text,
  ADD COLUMN IF NOT EXISTS rakuten_cross_match jsonb;

UPDATE public.discovered_products
SET
  price_jpy = COALESCE(price_jpy, price_krw),
  rakuten_item_code = COALESCE(rakuten_item_code, naver_product_id),
  rakuten_cross_match = COALESCE(rakuten_cross_match, naver_cross_match)
WHERE country = 'jp';

CREATE INDEX IF NOT EXISTS idx_dp_price_jpy
  ON public.discovered_products (price_jpy)
  WHERE price_jpy IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dp_rakuten_item_code
  ON public.discovered_products (rakuten_item_code)
  WHERE rakuten_item_code IS NOT NULL;

-- Broadcast-history compatibility ----------------------------------------
ALTER TABLE public.historical_broadcasts
  ADD COLUMN IF NOT EXISTS price_jpy int;

UPDATE public.historical_broadcasts
SET price_jpy = COALESCE(price_jpy, price_krw)
WHERE country = 'jp';

ALTER TABLE public.broadcast_products
  ADD COLUMN IF NOT EXISTS price_jpy int,
  ADD COLUMN IF NOT EXISTS original_price_jpy int;

UPDATE public.broadcast_products bp
SET
  price_jpy = COALESCE(bp.price_jpy, bp.price_krw),
  original_price_jpy = COALESCE(bp.original_price_jpy, bp.original_price_krw)
FROM public.broadcasts b
WHERE b.id = bp.broadcast_id
  AND b.country = 'jp';

-- Keep either currency-name write path readable by the other deployment.
CREATE OR REPLACE FUNCTION public.sync_dual_market_price_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.price_jpy IS NULL AND NEW.price_krw IS NOT NULL THEN
    NEW.price_jpy := NEW.price_krw;
  ELSIF NEW.price_krw IS NULL AND NEW.price_jpy IS NOT NULL THEN
    NEW.price_krw := NEW.price_jpy;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discovered_products_sync_market_price ON public.discovered_products;
CREATE TRIGGER discovered_products_sync_market_price
  BEFORE INSERT OR UPDATE OF price_jpy, price_krw
  ON public.discovered_products
  FOR EACH ROW EXECUTE FUNCTION public.sync_dual_market_price_columns();

DROP TRIGGER IF EXISTS historical_broadcasts_sync_market_price ON public.historical_broadcasts;
CREATE TRIGGER historical_broadcasts_sync_market_price
  BEFORE INSERT OR UPDATE OF price_jpy, price_krw
  ON public.historical_broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.sync_dual_market_price_columns();

CREATE OR REPLACE FUNCTION public.sync_dual_broadcast_product_price_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.price_jpy IS NULL AND NEW.price_krw IS NOT NULL THEN
    NEW.price_jpy := NEW.price_krw;
  ELSIF NEW.price_krw IS NULL AND NEW.price_jpy IS NOT NULL THEN
    NEW.price_krw := NEW.price_jpy;
  END IF;
  IF NEW.original_price_jpy IS NULL AND NEW.original_price_krw IS NOT NULL THEN
    NEW.original_price_jpy := NEW.original_price_krw;
  ELSIF NEW.original_price_krw IS NULL AND NEW.original_price_jpy IS NOT NULL THEN
    NEW.original_price_krw := NEW.original_price_jpy;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_products_sync_market_price ON public.broadcast_products;
CREATE TRIGGER broadcast_products_sync_market_price
  BEFORE INSERT OR UPDATE OF price_jpy, price_krw, original_price_jpy, original_price_krw
  ON public.broadcast_products
  FOR EACH ROW EXECUTE FUNCTION public.sync_dual_broadcast_product_price_columns();

-- Research-result compatibility ------------------------------------------
ALTER TABLE public.research_results
  ADD COLUMN IF NOT EXISTS japan_export_fit_score int,
  ADD COLUMN IF NOT EXISTS korea_market_fit jsonb;

ALTER TABLE public.research_results
  ADD COLUMN IF NOT EXISTS korea_fit_score int
    GENERATED ALWAYS AS (
      CASE
        WHEN korea_market_fit->>'fit_score' ~ '^[0-9]+$'
          THEN (korea_market_fit->>'fit_score')::int
      END
    ) STORED;

UPDATE public.research_results
SET
  japan_export_fit_score = COALESCE(
    japan_export_fit_score,
    CASE
      WHEN raw_json->'research'->>'japan_export_fit_score' ~ '^[0-9]+$'
        THEN (raw_json->'research'->>'japan_export_fit_score')::int
    END,
    CASE WHEN country = 'jp' THEN home_shopping_fit_score END
  ),
  korea_market_fit = COALESCE(
    korea_market_fit,
    raw_json->'research'->'korea_market_fit',
    CASE WHEN country = 'jp' THEN domestic_market_fit END
  );

CREATE INDEX IF NOT EXISTS idx_research_japan_export_fit_score
  ON public.research_results (japan_export_fit_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_research_korea_fit_score
  ON public.research_results (korea_fit_score DESC NULLS LAST);

-- Isolate feedback learning by market ------------------------------------
ALTER TABLE public.learning_state
  ADD COLUMN IF NOT EXISTS country text;
UPDATE public.learning_state SET country = 'jp' WHERE country IS NULL;
ALTER TABLE public.learning_state
  ALTER COLUMN country SET DEFAULT 'jp',
  ALTER COLUMN country SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'learning_state_country_check'
      AND conrelid = 'public.learning_state'::regclass
  ) THEN
    ALTER TABLE public.learning_state
      ADD CONSTRAINT learning_state_country_check CHECK (country IN ('jp', 'kr'));
  END IF;
END $$;

ALTER TABLE public.learning_state DROP CONSTRAINT IF EXISTS learning_state_pkey;
ALTER TABLE public.learning_state
  ADD CONSTRAINT learning_state_pkey PRIMARY KEY (context, country);

ALTER TABLE public.learning_insights
  ADD COLUMN IF NOT EXISTS country text;
UPDATE public.learning_insights SET country = 'jp' WHERE country IS NULL;
ALTER TABLE public.learning_insights
  ALTER COLUMN country SET DEFAULT 'jp',
  ALTER COLUMN country SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'learning_insights_country_check'
      AND conrelid = 'public.learning_insights'::regclass
  ) THEN
    ALTER TABLE public.learning_insights
      ADD CONSTRAINT learning_insights_country_check CHECK (country IN ('jp', 'kr'));
  END IF;
END $$;

ALTER TABLE public.learning_insights
  DROP CONSTRAINT IF EXISTS learning_insights_week_context_key;
ALTER TABLE public.learning_insights
  ADD CONSTRAINT learning_insights_week_context_country_key
  UNIQUE (week_start, context, country);

CREATE INDEX IF NOT EXISTS idx_learning_state_country_context
  ON public.learning_state (country, context);
CREATE INDEX IF NOT EXISTS idx_learning_insights_country_context
  ON public.learning_insights (country, context, week_start DESC);

-- History view must expose country so the API can filter before pagination.
CREATE OR REPLACE VIEW public.discovery_run_feedback_stats
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
  COALESCE(p.feedback_count, 0) AS feedback_count,
  r.country
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
