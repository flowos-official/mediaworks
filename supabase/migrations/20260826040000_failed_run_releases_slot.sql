-- A failed run must not hold the slot.
--
-- 20260826020000 stopped the duplicate invocations, but made the first arrival
-- final. On live_commerce the stale build arrives ~25 s ahead every night and
-- fails ~80 s in on a credential the current build no longer uses, so
-- first-one-wins handed it the night: 2026-08-25 23:30 recorded one run,
-- `failed`, produced 0 — where the pair had previously produced 30.
--
-- Rule: an in-flight or successful run keeps the slot, a failed one releases
-- it. The healthy caller waits for the blocking run to settle and takes over
-- when it failed (lib/cron/duplicate-guard.ts::waitForBlockingRun); that retry
-- has to be allowed through here.

BEGIN;

CREATE OR REPLACE FUNCTION public.reject_duplicate_crawl_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  previous public.historical_crawl_runs%ROWTYPE;
BEGIN
  SELECT * INTO previous
  FROM public.historical_crawl_runs
  WHERE run_at > now() - interval '5 minutes'
  ORDER BY run_at DESC
  LIMIT 1;

  IF previous.run_at IS NOT NULL AND previous.status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION
      'duplicate crawl invocation: a run started at % (status %, within 5 minutes)',
      previous.run_at, previous.status
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_duplicate_discovery_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  previous public.discovery_runs%ROWTYPE;
BEGIN
  -- Only the cron shape is guarded; strategy generation writes a synthetic
  -- session with iterations = 1 and a populated produced_count.
  IF NEW.iterations IS DISTINCT FROM 0 OR NEW.produced_count IS DISTINCT FROM 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO previous
  FROM public.discovery_runs
  WHERE context = NEW.context
    AND run_at > now() - interval '5 minutes'
  ORDER BY run_at DESC
  LIMIT 1;

  IF previous.run_at IS NOT NULL AND previous.status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION
      'duplicate discovery invocation for %: a run started at % (status %, within 5 minutes)',
      NEW.context, previous.run_at, previous.status
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
