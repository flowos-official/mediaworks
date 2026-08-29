import type { PipelineRunCounts } from "./pipeline-run";

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
		processed:
			summary.processed + summary.stale_requeued + summary.stale_abandoned,
	};
	return {
		status:
			counts.failed > 0 || summary.queued > 0 || summary.deferred > 0
				? "partial"
				: "succeeded",
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

export function audioPipelineOutcome(
	summary: AudioSummaryCounts,
	preflightFailures: number,
): { status: "succeeded" | "partial"; counts: PipelineRunCounts } {
	const counts: PipelineRunCounts = {
		new: summary.seeded + summary.done,
		updated: summary.recovered + summary.queued,
		duplicate: summary.skipped,
		failed: summary.failed + preflightFailures,
		processed: summary.processed + summary.seeded + summary.recovered,
	};
	return {
		status: counts.failed > 0 || summary.queued > 0 ? "partial" : "succeeded",
		counts,
	};
}
