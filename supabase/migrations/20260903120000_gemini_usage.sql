-- Record what every Gemini call consumed, attributed to the stage that made it.
--
-- A ~$100 bill arrived with no way to explain it. The broadcast-analysis drain
-- could be priced because it had just been instrumented — about $18 of it — and
-- the other twenty-odd call sites could not be priced at all, so the remaining
-- $80 had no owner. Every diagnosis available was inference from row counts:
-- "discovery produced 30 rows, so it probably called Gemini n times".
--
-- Rows are written best-effort by the caller and are pure telemetry: nothing
-- reads them to make a decision, and a failure to write one must never affect
-- the work that produced it.
--
-- `thinking_tokens` is separate because the screenplay generator pairs the Pro
-- model with HIGH thinking, and thinking is billed at the output rate while
-- being invisible in the response text — the exact shape of spend that a
-- row-count estimate cannot see.

BEGIN;

CREATE TABLE IF NOT EXISTS public.gemini_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  thinking_tokens integer NOT NULL DEFAULT 0 CHECK (thinking_tokens >= 0),
  cached_tokens integer NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  -- False for a call that consumed tokens and then failed — a MAX_TOKENS
  -- truncation bills for the full output and returns nothing usable, which is
  -- precisely the spend an outcome-based count misses.
  succeeded boolean NOT NULL DEFAULT true,
  error_code text,
  -- Free-text pointer back at the work: a broadcast id, a session id, a slug.
  subject text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gemini_usage_recent_idx
  ON public.gemini_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS gemini_usage_stage_idx
  ON public.gemini_usage (stage, created_at DESC);

ALTER TABLE public.gemini_usage ENABLE ROW LEVEL SECURITY;

-- Group B: spend is internal. Writes are service-role only, like the rest of
-- the derived telemetry.
DROP POLICY IF EXISTS gemini_usage_read ON public.gemini_usage;
CREATE POLICY gemini_usage_read ON public.gemini_usage
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

NOTIFY pgrst, 'reload schema';

COMMIT;
