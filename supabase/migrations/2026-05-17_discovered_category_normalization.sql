-- Discovery category normalization cache.
-- Spec: docs/superpowers/specs/2026-05-17-discovery-category-normalize-design.md
--
-- Maps free-form discovered_products.category strings (Rakuten genres) to
-- the curated channel_categories whitelist. First-seen raw categories are
-- classified by Gemini Flash and cached here; subsequent lookups are a
-- single PK fetch.

CREATE TABLE IF NOT EXISTS discovered_category_normalization (
  raw_category         text PRIMARY KEY,
  whitelist_categories text[] NOT NULL,                  -- 0..3 elements; empty = "no whitelist match"
  source               text NOT NULL CHECK (source IN ('gemini','manual')),
  classified_at        timestamptz NOT NULL DEFAULT now(),
  notes                text                              -- admin notes on manual overrides
);

CREATE INDEX IF NOT EXISTS idx_dcn_classified_at
  ON discovered_category_normalization (classified_at DESC);

-- RLS: Group B (member/admin only). Service role bypasses for cron paths.
ALTER TABLE public.discovered_category_normalization ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "member_read" ON public.discovered_category_normalization;
CREATE POLICY "member_read" ON public.discovered_category_normalization
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member', 'admin'));

DROP POLICY IF EXISTS "admin_write" ON public.discovered_category_normalization;
CREATE POLICY "admin_write" ON public.discovered_category_normalization
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');
