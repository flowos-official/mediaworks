-- 2026-08-25: broadcast selling-language corpus
-- Spec: docs/superpowers/specs/2026-08-24-broadcast-selling-language-design.md

BEGIN;

-- 1) Analysis queue on broadcasts, mirroring the video_status queue pattern.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS analysis_status   text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS analysis_error    text,
  ADD COLUMN IF NOT EXISTS analysis_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analyzed_at       timestamptz;

-- ADD COLUMN IF NOT EXISTS ... CHECK skips the constraint when the column
-- already exists, so a re-run would leave the column unconstrained. Add it
-- separately and idempotently.
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_analysis_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_analysis_status_check
  CHECK (analysis_status IN ('pending','queued','running','done','failed','skipped'));

CREATE INDEX IF NOT EXISTS broadcasts_analysis_queue_idx
  ON broadcasts (analysis_status, air_date DESC)
  WHERE archived_video_s3 IS NOT NULL;

-- 2) Verbatim transcript + every free-text field. Admin only.
CREATE TABLE IF NOT EXISTS broadcast_transcripts (
  broadcast_id   uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  segments       jsonb NOT NULL,
  act_summaries  jsonb NOT NULL,
  urgency_cues   jsonb NOT NULL,
  language       text  NOT NULL DEFAULT 'ja',
  model          text  NOT NULL,
  schema_version int   NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE broadcast_transcripts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON broadcast_transcripts FROM authenticated;

DROP POLICY IF EXISTS broadcast_transcripts_select ON broadcast_transcripts;
CREATE POLICY broadcast_transcripts_select
  ON broadcast_transcripts FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

COMMENT ON TABLE broadcast_transcripts IS
  'Verbatim competitor broadcast transcripts. Verification and re-analysis only. '
  'Never wire into a prompt, API response or UI. '
  'scripts/test-broadcast-intel-guard.ts enforces where this name may appear.';

-- 3) Structural patterns. Member-readable — therefore NUMBERS AND ENUM LABELS
--    ONLY. Adding a free-text field here makes it readable by anyone holding
--    the public anon key.
CREATE TABLE IF NOT EXISTS broadcast_speech_analyses (
  broadcast_id        uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('qvc','shopch')),
  air_date            date NOT NULL,
  category            text,
  duration_sec        int  NOT NULL CHECK (duration_sec > 0),
  segments            jsonb NOT NULL,
  selling_points      jsonb NOT NULL,
  evidence_cues       jsonb NOT NULL,
  objection_handlings jsonb NOT NULL,
  offer_timeline      jsonb NOT NULL,
  model               text NOT NULL,
  schema_version      int  NOT NULL DEFAULT 1,
  analyzed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bsa_category_idx
  ON broadcast_speech_analyses (category, air_date DESC);

ALTER TABLE broadcast_speech_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bsa_select ON broadcast_speech_analyses;
CREATE POLICY bsa_select
  ON broadcast_speech_analyses FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

-- 4) Reproducibility: which aggregate shaped this screenplay version.
ALTER TABLE screenplay_versions
  ADD COLUMN IF NOT EXISTS pattern_snapshot jsonb;

COMMIT;
