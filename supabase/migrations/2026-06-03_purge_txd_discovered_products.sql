-- 2026-06-03: Purge legacy テレ東マート (txd) rows from discovered_products.
--
-- Operator policy (2026-06-02, PR #89): txd products must not surface as
-- sourcing candidates in discovery / strategy. New rows are already dropped at
-- write time (lib/discovery/save.ts) and filtered at read (lib/discovery/cached.ts,
-- /api/discovery/today, lib/strategy/pool-query.ts). This one-shot removes the
-- ~40 LEGACY rows that predate the exclusion so they also drop out of
-- aggregates (category distribution, insights).
--
-- SCOPE: discovery only. The broadcasts competitor calendar
-- (historical_broadcasts channel='txd', ~9k rows) is intentionally KEPT — it is
-- reference data for what competitor channels are airing. Do NOT delete it.
--
-- Whole-token match: '(^|,)txd(,|$)' so a hypothetical 'txdx' never matches.
-- Guard: never delete a product that has ANY product_selection — active OR
-- closed. product_selections cascades from discovered_products (ON DELETE
-- CASCADE) and product_selection_events cascades from selections, so deleting a
-- product with a closed selection would also erase aired/dropped/postponed
-- history + its append-only audit log. Those are retention records; preserve
-- them. (At authoring time txd had 0 selections, so this deletes the same rows
-- either way — the broader guard is for safety on any future re-run.)

BEGIN;

DELETE FROM discovered_products dp
WHERE dp.tv_channel_source ~ '(^|,)txd(,|$)'
  AND NOT EXISTS (
    SELECT 1 FROM product_selections ps
    WHERE ps.discovered_product_id = dp.id
  );

COMMIT;
