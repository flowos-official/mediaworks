-- One snapshot per subject per formula per window.
--
-- 20260830110000 gave insight_refresh the sliding-window trigger, so two
-- invocations of the same trigger can no longer both proceed. This is the
-- second line: it makes a duplicate write harmless rather than merely
-- unlikely, and it covers the cases a cron guard cannot see at all — a manual
-- re-run, a retry, an operator draining a backlog by hand.
--
-- Without it `insight_snapshots` had no notion of identity: nothing stopped the
-- same subject being written twice for the same cutoff, and `evidence_count`
-- alone gave a reader no way to tell which row was authoritative.
--
-- Checked before adding: 137 rows, 137 distinct keys, zero collisions. The
-- constraint is therefore satisfiable as-is and needs no cleanup pass.
--
-- `input_until` is quantized by the caller (refreshInsightsCutoff) so two
-- near-simultaneous runs compute the same window and actually collide here.
-- That quantum has a boundary a pair can straddle, exactly as the old
-- 15-minute invocation bucket did — but the cost is now one redundant snapshot
-- rather than a corrupted scan cursor, and the trigger is what actually
-- prevents the pair.

BEGIN;

ALTER TABLE public.insight_snapshots
  ADD CONSTRAINT insight_snapshots_identity_key
  UNIQUE (insight_type, subject_type, subject_id, formula_version, input_until);

NOTIFY pgrst, 'reload schema';

COMMIT;
