-- Historical broadcasts imported from docs/他局OA（2020年4月～）.xlsx
-- Time-of-day is not available in the OA sheets — date-only.
-- 8 channels covered: japanet, junsanpo, ntv (poshure), tbs (kininaru),
-- dinos (fuji premium), senobura, uranoura (ABC), btops (yomiuri).

CREATE TABLE IF NOT EXISTS historical_broadcasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       text NOT NULL,            -- tv-channels.ts slug
  air_date      date NOT NULL,
  day_of_week   text,                     -- 月/火/水/木/金/土/日
  product_name  text NOT NULL,
  price_text    text,                     -- original raw text from xlsx
  price_jpy     int,                      -- best-effort parsed price (tax-incl preferred)
  price_is_tax_incl boolean,              -- null = unknown
  source_url    text,                     -- channel URL captured at top of sheet
  source_sheet  text NOT NULL,            -- original sheet name for traceability
  imported_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT historical_broadcasts_unique
    UNIQUE (channel, air_date, product_name)
);

CREATE INDEX IF NOT EXISTS historical_broadcasts_channel_date_idx
  ON historical_broadcasts (channel, air_date DESC);
CREATE INDEX IF NOT EXISTS historical_broadcasts_date_idx
  ON historical_broadcasts (air_date DESC);
-- Trigram-style search uses ILIKE; a plain btree on lower() helps prefix matches.
CREATE INDEX IF NOT EXISTS historical_broadcasts_product_lower_idx
  ON historical_broadcasts (lower(product_name));

-- RLS — member/admin read+write, viewer no access. Matches Group B convention.
ALTER TABLE public.historical_broadcasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "member_read" ON public.historical_broadcasts;
CREATE POLICY "member_read" ON public.historical_broadcasts
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member', 'admin'));

DROP POLICY IF EXISTS "member_all" ON public.historical_broadcasts;
CREATE POLICY "member_all" ON public.historical_broadcasts
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('member', 'admin'))
  WITH CHECK (public.current_user_role() IN ('member', 'admin'));
