-- Stop a cron path from recording two runs for the same trigger.
--
-- Every scheduled job has been invoked twice since at least 2026-08, the second
-- arriving 26-82 s after the first. An application-level guard shipped in
-- 3a4c3f5 and demonstrably works — a manual call 4m23s after a previous run is
-- refused — yet the scheduled invocations still produce two rows (2026-08-25
-- 16:30:16 and 16:30:59, with a run at 16:25:23 already inside the window).
-- Whatever issues the second call does not execute the guarded code, and the
-- Vercel deployment API exposes no way to identify it.
--
-- So the rule moves to the one place every writer must pass through. This is
-- symptom control: the duplicate caller is still unidentified.
--
-- The first invocation is unaffected. The duplicate fails loudly with an error
-- rather than being silently dropped — a silently skipped write is exactly the
-- failure mode that hid a 22-day data outage here in 2026-08.

BEGIN;

CREATE OR REPLACE FUNCTION public.reject_duplicate_crawl_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  previous timestamptz;
BEGIN
  SELECT run_at INTO previous
  FROM public.historical_crawl_runs
  WHERE run_at > now() - interval '5 minutes'
  ORDER BY run_at DESC
  LIMIT 1;

  IF previous IS NOT NULL THEN
    RAISE EXCEPTION
      'duplicate crawl invocation: a run started at % (within 5 minutes)', previous
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS historical_crawl_runs_reject_duplicate ON public.historical_crawl_runs;
CREATE TRIGGER historical_crawl_runs_reject_duplicate
  BEFORE INSERT ON public.historical_crawl_runs
  FOR EACH ROW EXECUTE FUNCTION public.reject_duplicate_crawl_run();

-- discovery_runs carries two kinds of row. The nightly cron starts one with
-- iterations = 0 and produced_count = 0 (lib/discovery/save.ts::createSession);
-- strategy generation writes a synthetic session with iterations = 1 and its
-- produced_count already set (lib/strategy/fresh-search-persist.ts). Only the
-- cron shape is guarded, so generating a strategy right after a discovery run
-- keeps working.
CREATE OR REPLACE FUNCTION public.reject_duplicate_discovery_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  previous timestamptz;
BEGIN
  IF NEW.iterations IS DISTINCT FROM 0 OR NEW.produced_count IS DISTINCT FROM 0 THEN
    RETURN NEW;  -- not a cron start
  END IF;

  SELECT run_at INTO previous
  FROM public.discovery_runs
  WHERE context = NEW.context
    AND run_at > now() - interval '5 minutes'
  ORDER BY run_at DESC
  LIMIT 1;

  IF previous IS NOT NULL THEN
    RAISE EXCEPTION
      'duplicate discovery invocation for %: a run started at % (within 5 minutes)',
      NEW.context, previous
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discovery_runs_reject_duplicate ON public.discovery_runs;
CREATE TRIGGER discovery_runs_reject_duplicate
  BEFORE INSERT ON public.discovery_runs
  FOR EACH ROW EXECUTE FUNCTION public.reject_duplicate_discovery_run();

NOTIFY pgrst, 'reload schema';

COMMIT;
