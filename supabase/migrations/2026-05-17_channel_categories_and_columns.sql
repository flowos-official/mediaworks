-- Phase 1-C: per-slot category metadata + user-curated whitelist.
-- Slots are persisted ONLY if their category is in the whitelist.

ALTER TABLE broadcasts            ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE historical_broadcasts ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE qvc_products          ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS idx_broadcasts_category
  ON broadcasts (channel, category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_historical_broadcasts_category
  ON historical_broadcasts (channel, category) WHERE category IS NOT NULL;

-- Whitelist: which categories are eligible for ingestion per channel.
CREATE TABLE IF NOT EXISTS channel_categories (
  channel     text NOT NULL,
  category    text NOT NULL,
  is_allowed  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, category)
);

ALTER TABLE channel_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_member ON channel_categories;
CREATE POLICY read_member ON channel_categories
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('member','admin'))
  );

DROP POLICY IF EXISTS write_admin ON channel_categories;
CREATE POLICY write_admin ON channel_categories
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- Seed: user-curated whitelist (2026-05-17 meeting feedback).
INSERT INTO channel_categories (channel, category) VALUES
  ('qvc',    'ビューティー'),
  ('qvc',    'ファッション小物'),
  ('qvc',    '健康・ダイエット'),
  ('qvc',    'ホーム'),
  ('qvc',    'キッチングッズ'),
  ('qvc',    'レジャー・ホビー'),
  ('qvc',    '家電'),
  ('shopch', '靴・バッグ・小物・インナー'),
  ('shopch', 'コスメ'),
  ('shopch', '美容・ダイエット・フィットネス'),
  ('shopch', 'ホーム・インテリア'),
  ('shopch', '家電')
ON CONFLICT (channel, category) DO NOTHING;
