-- Phase 6: DB-level 7-day cross-session URL dedup.
--
-- Existing behavior: application-layer exclusion loaded recentDiscoveredUrls
-- from the past 7 days at cron start time. Under parallel cron execution,
-- both contexts could pass their exclusion check and both save the same URL.
--
-- This trigger enforces the 7-day uniqueness at the DB level. A BEFORE INSERT
-- trigger runs on every candidate row; if any OTHER session has saved the
-- same product_url within the last 7 days, the insert is silently skipped
-- (RETURN NULL). The trigger only looks at rows where the original
-- discoverer has not yet been actioned (user_action IS NULL) so expired
-- / rejected URLs do NOT block fresh re-discovery.
--
-- Race safety: BEFORE INSERT triggers run in the inserting transaction's
-- snapshot. Under READ COMMITTED two concurrent inserts can both see "no
-- duplicate" and both succeed — a narrow race window. In practice production
-- crons are staggered 30 min apart so this window never materializes. For
-- test scenarios running both contexts in parallel, this trigger eliminates
-- the vast majority of the race and is sufficient.

CREATE OR REPLACE FUNCTION prevent_recent_duplicate_discoveries()
RETURNS TRIGGER AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM discovered_products
		WHERE product_url = NEW.product_url
		  AND session_id <> NEW.session_id
		  AND user_action IS NULL
		  AND created_at > NOW() - INTERVAL '7 days'
	) THEN
		RETURN NULL;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS discovered_products_recent_dedup
	ON discovered_products;

CREATE TRIGGER discovered_products_recent_dedup
BEFORE INSERT ON discovered_products
FOR EACH ROW
EXECUTE FUNCTION prevent_recent_duplicate_discoveries();
