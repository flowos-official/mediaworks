-- Selection Outcome Loop (spec 2026-05-29)
-- Denormalize the furthest product_selections pipeline stage onto
-- discovered_products, plus a calibration view making tv_fit_score falsifiable.

BEGIN;

-- 1a. Columns + index
ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS selection_outcome text
    CHECK (selection_outcome IN ('selected','sourcing','scheduled','aired','dropped')),
  ADD COLUMN IF NOT EXISTS selection_outcome_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_dp_selection_outcome
  ON discovered_products (context, selection_outcome)
  WHERE selection_outcome IS NOT NULL;

-- 1b. Write-back trigger (single source of truth; SECURITY DEFINER bypasses RLS)
CREATE OR REPLACE FUNCTION sync_selection_outcome() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cand text; cand_rank int; cur text; cur_rank int;
BEGIN
  IF    NEW.status = 'selected'  THEN cand := 'selected';
  ELSIF NEW.status = 'sourcing'  THEN cand := 'sourcing';
  ELSIF NEW.status = 'scheduled' THEN cand := 'scheduled';
  ELSIF NEW.status = 'closed' AND NEW.closed_reason = 'aired'   THEN cand := 'aired';
  ELSIF NEW.status = 'closed' AND NEW.closed_reason = 'dropped' THEN cand := 'dropped';
  ELSE  RETURN NEW;  -- postponed / unrecognized → leave outcome untouched
  END IF;

  SELECT selection_outcome INTO cur
    FROM discovered_products WHERE id = NEW.discovered_product_id FOR UPDATE;

  cur_rank := CASE cur WHEN 'selected' THEN 1 WHEN 'sourcing' THEN 2
                       WHEN 'scheduled' THEN 3 WHEN 'aired' THEN 4 ELSE 0 END;

  IF cand = 'dropped' THEN
    IF cur IS NULL OR cur = 'selected' THEN
      UPDATE discovered_products
         SET selection_outcome = 'dropped', selection_outcome_at = now()
       WHERE id = NEW.discovered_product_id;
    END IF;
  ELSE
    cand_rank := CASE cand WHEN 'selected' THEN 1 WHEN 'sourcing' THEN 2
                          WHEN 'scheduled' THEN 3 WHEN 'aired' THEN 4 END;
    IF cand_rank > cur_rank THEN
      UPDATE discovered_products
         SET selection_outcome = cand, selection_outcome_at = now()
       WHERE id = NEW.discovered_product_id;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS product_selections_outcome_sync ON product_selections;
CREATE TRIGGER product_selections_outcome_sync
  AFTER INSERT OR UPDATE OF status ON product_selections
  FOR EACH ROW EXECUTE FUNCTION sync_selection_outcome();

-- 1c. Calibration view (security_invoker honors the caller's RLS)
CREATE OR REPLACE VIEW discovery_score_calibration
  WITH (security_invoker = true) AS
SELECT
  context,
  width_bucket(tv_fit_score, ARRAY[40,60,75]) AS score_band,
  count(*) AS shown,
  count(*) FILTER (WHERE selection_outcome IN ('selected','sourcing','scheduled','aired')) AS selected_plus,
  count(*) FILTER (WHERE selection_outcome IN ('sourcing','scheduled','aired')) AS sourced_plus,
  count(*) FILTER (WHERE selection_outcome IN ('scheduled','aired')) AS scheduled_plus,
  count(*) FILTER (WHERE selection_outcome = 'aired') AS aired,
  count(*) FILTER (WHERE selection_outcome = 'dropped') AS dropped
FROM discovered_products
WHERE created_at >= now() - interval '90 days'
  AND tv_fit_score IS NOT NULL
  AND tv_fit_reason IS DISTINCT FROM 'Strategy fresh_search rec — score not computed'
GROUP BY context, score_band;

-- 1d. One-time backfill from current selection status
WITH ranked AS (
  SELECT discovered_product_id AS dpid,
         max(CASE WHEN status='closed' AND closed_reason='aired' THEN 4
                  WHEN status='scheduled' THEN 3 WHEN status='sourcing' THEN 2
                  WHEN status='selected'  THEN 1 ELSE 0 END) AS pos_rank,
         bool_or(status='closed' AND closed_reason='dropped') AS any_dropped
  FROM product_selections GROUP BY discovered_product_id)
UPDATE discovered_products dp SET
  selection_outcome = CASE WHEN r.pos_rank=4 THEN 'aired' WHEN r.pos_rank=3 THEN 'scheduled'
                           WHEN r.pos_rank=2 THEN 'sourcing' WHEN r.pos_rank=1 THEN 'selected'
                           WHEN r.any_dropped THEN 'dropped' END,
  selection_outcome_at = now()
FROM ranked r WHERE dp.id = r.dpid AND (r.pos_rank > 0 OR r.any_dropped);

COMMIT;
