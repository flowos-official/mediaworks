-- Preserve a safe, operator-facing failure reason when a Workflow run fails.
-- This allows the status polling fallback to explain invalid AI credentials or
-- temporary provider failures even when the progress stream disconnects.

ALTER TABLE public.screenplays
  ADD COLUMN IF NOT EXISTS last_error text;

COMMENT ON COLUMN public.screenplays.last_error IS
  'Sanitized operator-facing reason for the latest failed screenplay run; cleared on start/success.';

NOTIFY pgrst, 'reload schema';
