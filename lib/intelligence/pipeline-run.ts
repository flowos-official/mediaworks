import type { SupabaseClient } from "@supabase/supabase-js";

export interface PipelineRunCounts {
	new: number;
	updated: number;
	duplicate: number;
	failed: number;
	processed?: number;
}

export interface PipelineRunHandle {
	id: string;
	heartbeat(counts?: Partial<PipelineRunCounts>): Promise<void>;
	succeed(counts: PipelineRunCounts): Promise<void>;
	partial(counts: PipelineRunCounts, errorCode: string, summary: string): Promise<void>;
	fail(errorCode: string, summary: string): Promise<void>;
}

export interface PipelineRunRepository {
	insert(input: {
		sourceType: string;
		jobType: string;
		externalRunId: string;
		targetScope: Record<string, unknown>;
	}): Promise<{ id: string }>;
	update(id: string, patch: Record<string, unknown>): Promise<void>;
}

export function createPipelineRunRepository(
	supabase: SupabaseClient,
): PipelineRunRepository {
	return {
		async insert(input) {
			const { data, error } = await supabase
				.from("data_pipeline_runs")
				.insert({
					source_type: input.sourceType,
					job_type: input.jobType,
					external_run_id: input.externalRunId,
					target_scope: input.targetScope,
					counts: {},
					status: "running",
				})
				.select("id")
				.single();
			if (error) throw error;
			if (!data?.id) throw new Error("data_pipeline_runs insert returned no id");
			return { id: data.id };
		},

		async update(id, patch) {
			const { error } = await supabase
				.from("data_pipeline_runs")
				.update(patch)
				.eq("id", id);
			if (error) throw error;
		},
	};
}

/**
 * A run whose heartbeat has gone quiet for this long is treated as orphaned.
 * Matches `recoverStaleAnalysis`, and comfortably exceeds the 300s ceiling any
 * of these functions can run for, so a live run is never mistaken for a dead
 * one.
 */
export const ORPHANED_PIPELINE_RUN_AFTER_MS = 30 * 60_000;

/**
 * Settle runs that no function is coming back to finish.
 *
 * When Vercel kills a function at `maxDuration` nothing writes a terminal
 * status, so the row stays `running` with a null `finished_at` forever. Left
 * alone those rows are not merely untidy: the insight refresh resumes from the
 * newest run carrying a cursor, and the duplicate-guard trigger treats a live
 * run as holding the slot — so one orphan could both skip a block of subjects
 * and block the job that would have caught up.
 *
 * This is a preflight sweep rather than a cron of its own, the same shape as
 * `recoverStaleDownloading` in the archive path. Best-effort by design: the
 * caller logs a failure and carries on, because reaping stale telemetry is
 * never a reason to skip the actual work.
 */
export async function reapOrphanedPipelineRuns(
	supabase: SupabaseClient,
	now: Date = new Date(),
	olderThanMs: number = ORPHANED_PIPELINE_RUN_AFTER_MS,
): Promise<number> {
	const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
	const { data, error } = await supabase
		.from("data_pipeline_runs")
		.update({
			status: "failed",
			finished_at: now.toISOString(),
			error_code: "orphaned",
			error_summary: `run was still ${"running"} with no heartbeat since ${cutoff}; settled by the orphan sweep`,
		})
		.in("status", ["running", "queued"])
		// `heartbeat_at` is null until the first beat, so fall back to the start.
		.or(`heartbeat_at.lt.${cutoff},and(heartbeat_at.is.null,started_at.lt.${cutoff})`)
		.select("id");
	if (error) throw new Error(`orphaned pipeline run sweep failed: ${error.message}`);
	return data?.length ?? 0;
}

const MAX_ERROR_SUMMARY_LENGTH = 1_000;

function timestamp(): string {
	return new Date().toISOString();
}

function cappedSummary(summary: string): string {
	return summary.slice(0, MAX_ERROR_SUMMARY_LENGTH);
}

export async function startPipelineRun(
	repository: PipelineRunRepository,
	input: {
		sourceType: string;
		jobType: string;
		externalRunId: string;
		targetScope: Record<string, unknown>;
	},
): Promise<PipelineRunHandle> {
	const { id } = await repository.insert(input);
	let knownCounts: Partial<PipelineRunCounts> = {};
	let terminal = false;

	const ensureRunning = () => {
		if (terminal) throw new Error("cannot update a terminal pipeline run");
	};

	const finish = async (
		status: "succeeded" | "partial" | "failed",
		counts?: PipelineRunCounts,
		error?: { code: string; summary: string },
	): Promise<void> => {
		ensureRunning();
		terminal = true;
		const nextCounts = counts ? { ...knownCounts, ...counts } : knownCounts;
		try {
			await repository.update(id, {
				status,
				counts: nextCounts,
				finished_at: timestamp(),
				...(error
					? {
						error_code: error.code,
						error_summary: cappedSummary(error.summary),
					}
					: {}),
			});
			knownCounts = nextCounts;
		} catch (error) {
			terminal = false;
			throw error;
		}
	};

	return {
		id,
		async heartbeat(counts = {}) {
			ensureRunning();
			const nextCounts = { ...knownCounts, ...counts };
			await repository.update(id, {
				status: "running",
				counts: nextCounts,
				heartbeat_at: timestamp(),
			});
			knownCounts = nextCounts;
		},
		async succeed(counts) {
			await finish("succeeded", counts);
		},
		async partial(counts, errorCode, summary) {
			await finish("partial", counts, { code: errorCode, summary });
		},
		async fail(errorCode, summary) {
			await finish("failed", undefined, { code: errorCode, summary });
		},
	};
}
