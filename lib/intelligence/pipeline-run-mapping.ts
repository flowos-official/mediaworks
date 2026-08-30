import type { PipelineRunCounts } from "./pipeline-run";

export interface DiscoverySaveBreakdown {
	attempted: number;
	excluded: number;
	saved: number;
	duplicate: number;
}

/**
 * `failed` stays 0 on purpose, and it is now honest rather than merely
 * convenient: `saveDiscoveredProducts` throws on a database error, so a failure
 * cannot reach this mapping at all — the cron records the run as failed
 * instead. What this used to get wrong was the other side, reporting
 * `attempted - saved` wholesale as `duplicate` and thereby merging a candidate
 * we refused on channel policy with a URL the database already had.
 *
 * A policy exclusion is a decision, not a collision, so it is counted as
 * `updated` — work observed and deliberately not written — and only rows the
 * database actually skipped count as `duplicate`.
 */
export function discoveryPipelineCounts(
	breakdown: DiscoverySaveBreakdown,
): PipelineRunCounts {
	const attempted = Math.max(0, breakdown.attempted);
	const saved = Math.min(attempted, Math.max(0, breakdown.saved));
	const excluded = Math.min(attempted - saved, Math.max(0, breakdown.excluded));
	const duplicate = Math.max(0, attempted - saved - excluded);
	return {
		new: saved,
		updated: excluded,
		duplicate,
		failed: 0,
		processed: attempted,
	};
}

export interface ArchiveSummaryCounts {
	processed: number;
	archived: number;
	queued: number;
	abandoned: number;
	deferred: number;
	failed_unsupported: number;
	stale_requeued: number;
	stale_abandoned: number;
}

/**
 * `partial` means degraded, not busy.
 *
 * `deferred` is the normal outcome for a slot whose `pgmMovie` is null and
 * `queued` is the drainer's normal backpressure, so treating either as a
 * downgrade made every healthy run `partial` — seven of the last nine in
 * production, each with zero failures. A badge that is always red trains an
 * operator to ignore it, which costs more than the signal was worth. Both
 * values are already carried as numbers in `counts`; they do not also need to
 * be promoted to a status.
 *
 * `stale_requeued` slots return to 'queued' and may be drained again in this
 * same run, where the loop counts them, so they stay out of `processed`.
 * `stale_abandoned` slots are terminal and were only ever handled by the
 * recovery step, so they belong in it.
 */
export function archivePipelineOutcome(
	summary: ArchiveSummaryCounts,
	preflightFailures: number,
): { status: "succeeded" | "partial"; counts: PipelineRunCounts } {
	const counts: PipelineRunCounts = {
		new: summary.archived,
		updated: summary.queued + summary.deferred + summary.stale_requeued,
		duplicate: 0,
		failed:
			summary.abandoned +
			summary.failed_unsupported +
			summary.stale_abandoned +
			preflightFailures,
		processed: summary.processed + summary.stale_abandoned,
	};
	return {
		status: counts.failed > 0 ? "partial" : "succeeded",
		counts,
	};
}

export interface AudioSummaryCounts {
	recovered: number;
	seeded: number;
	processed: number;
	done: number;
	queued: number;
	failed: number;
	skipped: number;
}

/**
 * Same rule as archive: `queued` is a retry waiting its turn, not a fault.
 *
 * Seeding and stale recovery both run before the drain loop and hand their
 * slots to it, so counting them in `processed` counted the same slot twice.
 * They are state changes — `updated` — and only `done` is new output.
 */
export function audioPipelineOutcome(
	summary: AudioSummaryCounts,
	preflightFailures: number,
): { status: "succeeded" | "partial"; counts: PipelineRunCounts } {
	const counts: PipelineRunCounts = {
		new: summary.done,
		updated: summary.seeded + summary.recovered + summary.queued,
		duplicate: summary.skipped,
		failed: summary.failed + preflightFailures,
		processed: summary.processed,
	};
	return {
		status: counts.failed > 0 ? "partial" : "succeeded",
		counts,
	};
}
