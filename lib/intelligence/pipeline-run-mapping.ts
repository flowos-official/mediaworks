import type { PipelineRunCounts } from "./pipeline-run";

/**
 * `saveDiscoveredProducts` returns a single count, so a row rejected by the
 * recent-duplicate trigger and a row lost to a database error are
 * indistinguishable here and both land in `duplicate`. `failed` is 0 because
 * this mapping genuinely cannot observe a failure, not because none happened —
 * telling the two apart needs the save path to report them separately.
 */
export function discoveryPipelineCounts(
	attempted: number,
	saved: number,
): PipelineRunCounts {
	const safeAttempted = Math.max(0, attempted);
	const safeSaved = Math.min(safeAttempted, Math.max(0, saved));
	return {
		new: safeSaved,
		updated: 0,
		duplicate: safeAttempted - safeSaved,
		failed: 0,
		processed: safeAttempted,
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
