import {
	startPipelineRun,
	type PipelineRunHandle,
	type PipelineRunRepository,
} from "./pipeline-run";

export type PipelineRunRouteReporter = (phase: "start" | "settle", error: unknown) => void;

type PipelineRunInput = {
	sourceType: string;
	jobType: string;
	externalRunId: string;
	targetScope: Record<string, unknown>;
};

export async function startPipelineRunBestEffort(
	repository: PipelineRunRepository,
	input: PipelineRunInput,
	report: PipelineRunRouteReporter,
): Promise<PipelineRunHandle | null> {
	try {
		return await startPipelineRun(repository, input);
	} catch (error) {
		report("start", error);
		return null;
	}
}

export async function settlePipelineRunBestEffort(
	run: PipelineRunHandle | null,
	settle: (run: PipelineRunHandle) => Promise<void>,
	report: PipelineRunRouteReporter,
): Promise<void> {
	if (!run) return;
	try {
		await settle(run);
	} catch (error) {
		report("settle", error);
	}
}

export async function returnAfterPipelineFailure<T>(
	run: PipelineRunHandle | null,
	errorCode: string,
	summary: string,
	primaryResponse: T,
	report: PipelineRunRouteReporter,
): Promise<T> {
	await settlePipelineRunBestEffort(run, (handle) => handle.fail(errorCode, summary), report);
	return primaryResponse;
}

export async function throwAfterPipelineFailure(
	run: PipelineRunHandle | null,
	errorCode: string,
	summary: string,
	primaryError: unknown,
	report: PipelineRunRouteReporter,
): Promise<never> {
	await settlePipelineRunBestEffort(run, (handle) => handle.fail(errorCode, summary), report);
	throw primaryError;
}
