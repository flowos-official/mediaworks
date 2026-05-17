-- Phase 1-D: optional start_time for historical_broadcasts rows.
--
-- The 8 OA channels currently scraped (japanet, junsanpo, ntv, tbs, dinos,
-- senobura, uranoura, btops) do not expose per-slot start times on their
-- public schedule pages, so start_time stays NULL for them. The column is
-- added now so future parsers (or future re-audits of existing parsers
-- where start time becomes available) can fill it without another schema
-- change.
--
-- Note: the existing UNIQUE(channel, air_date, product_name) constraint is
-- intentionally left as-is. PostgreSQL treats NULLs as distinct in UNIQUE
-- constraints, so multiple NULL start_times for the same product/day still
-- collide on the existing key — which matches the current de-dup intent.
-- If a future channel actually exposes multiple distinct broadcast slots
-- for the same product on the same day, the UNIQUE constraint can be
-- widened then.

ALTER TABLE historical_broadcasts
  ADD COLUMN IF NOT EXISTS start_time time;
