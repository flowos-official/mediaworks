-- Phase #10: AI analysis cache for competitor broadcast slots.
-- Each row holds Gemini's "could we sell this?" verdict for a given
-- (channel, normalized product) pair. UI looks up by slot_key before
-- triggering a fresh Gemini call.
--
-- slot_key format: lower(channel) || '|' || md5(productName + airDate)
-- Kept opaque to the schema; the API computes it. Index lets us look up
-- the latest row for a slot in O(1).

CREATE TABLE IF NOT EXISTS competitor_fit_analyses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_key            text NOT NULL,
  channel             text NOT NULL,
  product_name        text NOT NULL,
  category            text,
  price_text          text,
  air_date            date NOT NULL,
  start_time          time,
  source_url          text,
  fit_score           int NOT NULL CHECK (fit_score BETWEEN 0 AND 100),
  summary             text NOT NULL,
  recommended_timing  text NOT NULL,
  recommended_channel text NOT NULL CHECK (recommended_channel IN ('tv','ec','live','tv+ec','skip')),
  differentiation     jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks               jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence          text NOT NULL CHECK (confidence IN ('low','medium','high')),
  generated_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cfa_slot_key ON competitor_fit_analyses (slot_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cfa_channel_date ON competitor_fit_analyses (channel, air_date DESC);

ALTER TABLE competitor_fit_analyses ENABLE ROW LEVEL SECURITY;

-- Members + admins can read all analyses; viewers excluded (this is
-- internal merchandising intelligence, not customer-facing).
DROP POLICY IF EXISTS member_read ON competitor_fit_analyses;
CREATE POLICY member_read ON competitor_fit_analyses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role IN ('member','admin')
    )
  );

-- Only the service role / cron can insert (the API uses service client).
DROP POLICY IF EXISTS service_write ON competitor_fit_analyses;
CREATE POLICY service_write ON competitor_fit_analyses
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role IN ('member','admin')
    )
  );
