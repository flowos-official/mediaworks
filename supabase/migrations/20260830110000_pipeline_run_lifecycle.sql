-- Give data_pipeline_runs the duplicate rule the other cron paths already have,
-- and an index for the way readiness actually queries it.
--
-- `insight_refresh` is the one job whose mutual exclusion lives in this table.
-- Every other cron here owns a domain table — discovery_runs,
-- historical_crawl_runs, broadcasts.analysis_status, broadcasts.video_status —
-- and that domain table stays the source of truth for job state. The pipeline
-- row is derived observation and must never gate work, so this trigger is
-- deliberately scoped to the single job that has nowhere else to hold a slot.
--
-- The route previously guarded itself with a fixed 15-minute bucket in
-- external_run_id. That cannot work against the duplicate this project actually
-- sees: 20260826020000 documents the second invocation arriving 26-82 seconds
-- after the first, and a pair straddling a bucket boundary (20:14:50 and
-- 20:15:20) produced two different ids and therefore no collision at all. The
-- sliding window from that migration does not have a boundary to straddle.
--
-- 20260826040000's rule is carried over intact: an in-flight or successful run
-- keeps the slot, a failed one releases it, so a healthy caller can take over
-- from a stale build that failed. Orphaned runs release it too — a function
-- killed at maxDuration leaves `running` behind forever, and without this the
-- job would be blocked by a run that can never finish.

BEGIN;

CREATE OR REPLACE FUNCTION public.reject_duplicate_pipeline_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  previous public.data_pipeline_runs%ROWTYPE;
BEGIN
  IF NEW.job_type IS DISTINCT FROM 'insight_refresh' THEN
    RETURN NEW;  -- every other job is guarded by its own domain table
  END IF;

  SELECT * INTO previous
  FROM public.data_pipeline_runs
  WHERE source_type = NEW.source_type
    AND job_type = NEW.job_type
    AND started_at > now() - interval '5 minutes'
  ORDER BY started_at DESC
  LIMIT 1;

  IF previous.started_at IS NOT NULL
     AND previous.status IS DISTINCT FROM 'failed'
     -- An orphan holds no slot: nothing is going to settle it.
     AND coalesce(previous.heartbeat_at, previous.started_at) > now() - interval '30 minutes'
  THEN
    RAISE EXCEPTION
      'duplicate pipeline invocation for %/%: a run started at % (status %, within 5 minutes)',
      NEW.source_type, NEW.job_type, previous.started_at, previous.status
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS data_pipeline_runs_reject_duplicate ON public.data_pipeline_runs;
CREATE TRIGGER data_pipeline_runs_reject_duplicate
  BEFORE INSERT ON public.data_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION public.reject_duplicate_pipeline_run();

-- readiness reads the failure table as `status IN ('failed','partial')` ordered
-- by started_at. `pipeline_runs_latest_idx` leads with source_type, so it does
-- nothing for that query, and this table only grows.
CREATE INDEX IF NOT EXISTS pipeline_runs_attention_idx
  ON public.data_pipeline_runs (started_at DESC)
  WHERE status IN ('failed', 'partial');

-- The reaper sweeps unsettled runs by heartbeat age.
CREATE INDEX IF NOT EXISTS pipeline_runs_unsettled_idx
  ON public.data_pipeline_runs (started_at DESC)
  WHERE status IN ('queued', 'running');

NOTIFY pgrst, 'reload schema';

COMMIT;
