-- 2026-05-19: complete Group A RLS for broadcast_products with admin write policy.
-- Follow-up to 2026-05-19_broadcast_products_and_brand.sql which omitted this policy.

BEGIN;

DROP POLICY IF EXISTS broadcast_products_admin_write ON broadcast_products;
CREATE POLICY broadcast_products_admin_write
  ON broadcast_products
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

COMMIT;
