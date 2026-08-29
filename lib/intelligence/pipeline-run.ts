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
				...(Object.keys(nextCounts).length > 0 ? { counts: nextCounts } : {}),
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
