-- Owner-scoped write policies for the product finder.
--
-- 20260829140000 shipped SELECT policies only, following the intelligence
-- layer's shape where every writer is service-role. That is the wrong template
-- here: a recommendation run is started BY a user, from a request, and the run
-- service writes through the user's client — so with reads alone, every run
-- failed at the first insert.
--
-- The right precedent is 2026-05-24_product_selections.sql, which is also
-- user-initiated and also owner-scoped. `getServiceClient()` is explicitly
-- reserved for cron and workflow paths (CLAUDE.md), so bypassing RLS to make
-- this work would have been the wrong fix.
--
-- No DELETE policy anywhere. A run is an audit record of what was recommended
-- and on what evidence; deleting one would erase the account of a decision the
-- operator may already have acted on. A user who wants a run gone can ignore
-- it; a service-role caller can still remove it if it must be.
--
-- Every policy carries the member|admin grade as well as ownership, for the
-- same reason the read policies do: these rows derive from member-only
-- canonical_products and evidence_items.

BEGIN;

-- Runs: a user may create and advance only their own.
DROP POLICY IF EXISTS product_recommendation_runs_owner_insert ON product_recommendation_runs;
CREATE POLICY product_recommendation_runs_owner_insert ON product_recommendation_runs
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.current_user_role() IN ('member','admin'));

DROP POLICY IF EXISTS product_recommendation_runs_owner_update ON product_recommendation_runs;
CREATE POLICY product_recommendation_runs_owner_update ON product_recommendation_runs
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid() AND public.current_user_role() IN ('member','admin'))
  -- The row must still belong to the same user afterwards: without this a
  -- completing UPDATE could hand the run to somebody else.
  WITH CHECK (created_by = auth.uid());

-- Items: insertable only into a run the user owns. No UPDATE — an item is the
-- ranking as it stood, and editing one would rewrite history that the
-- knowledge snapshot claims to describe.
DROP POLICY IF EXISTS product_recommendation_items_owner_insert ON product_recommendation_items;
CREATE POLICY product_recommendation_items_owner_insert ON product_recommendation_items
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('member','admin')
    AND EXISTS (
      SELECT 1 FROM product_recommendation_runs r
      WHERE r.id = run_id AND r.created_by = auth.uid()
    )
  );

-- Decisions: the user's own annotation on an item they can see. Updatable,
-- because changing one's mind about a product is the normal case.
DROP POLICY IF EXISTS product_recommendation_decisions_owner_insert ON product_recommendation_decisions;
CREATE POLICY product_recommendation_decisions_owner_insert ON product_recommendation_decisions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.current_user_role() IN ('member','admin')
    AND EXISTS (
      SELECT 1
      FROM product_recommendation_items i
      JOIN product_recommendation_runs r ON r.id = i.run_id
      WHERE i.id = item_id AND r.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS product_recommendation_decisions_owner_update ON product_recommendation_decisions;
CREATE POLICY product_recommendation_decisions_owner_update ON product_recommendation_decisions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.current_user_role() IN ('member','admin'))
  WITH CHECK (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';

COMMIT;
