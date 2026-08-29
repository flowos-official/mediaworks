import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	returnAfterPipelineFailure,
	settlePipelineRunBestEffort,
	startPipelineRunBestEffort,
	throwAfterPipelineFailure,
} from "../lib/intelligence/pipeline-run-route";
import type { PipelineRunHandle, PipelineRunRepository } from "../lib/intelligence/pipeline-run";

const input = {
	sourceType: "test",
	jobType: "test_job",
	externalRunId: "route-contract",
	targetScope: {},
};

async function main() {
	{
		const errors: string[] = [];
		const repository: PipelineRunRepository = {
			insert: async () => { throw new Error("insert unavailable"); },
			update: async () => undefined,
		};
		const run = await startPipelineRunBestEffort(repository, input, (_phase, error) => errors.push(String(error)));
		assert.equal(run, null);
		assert.match(errors[0] ?? "", /insert unavailable/);
		console.log("✓ recorder start failure is isolated from the primary route flow");
	}

	{
		let failAttempts = 0;
		const run: PipelineRunHandle = {
			id: "run-1",
			heartbeat: async () => undefined,
			succeed: async () => { throw new Error("recorder unavailable"); },
			partial: async () => undefined,
			fail: async () => { failAttempts++; throw new Error("recorder unavailable"); },
		};
		await settlePipelineRunBestEffort(run, (handle) => handle.succeed({ new: 0, updated: 0, duplicate: 0, failed: 0 }), () => undefined);
		const primaryResponse = { status: 500, body: "existing response" };
		const result = await returnAfterPipelineFailure(
			run,
			"existing_query_error",
			"database unavailable",
			primaryResponse,
			() => undefined,
		);
		assert.equal(result, primaryResponse);
		assert.equal(failAttempts, 1);
		const primaryError = new Error("existing thrown error");
		await assert.rejects(
			() => throwAfterPipelineFailure(run, "existing_failure", "failed", primaryError, () => undefined),
			(error: unknown) => error === primaryError,
		);
		console.log("✓ handled query failure keeps the original response when recorder failure recording fails");
	}

	for (const route of [
		"app/api/cron/daily-discovery-home/route.ts",
		"app/api/cron/daily-discovery-live/route.ts",
		"app/api/cron/daily-broadcasts/route.ts",
		"app/api/cron/daily-historical-broadcasts/route.ts",
		"app/api/cron/archive-videos/route.ts",
		"app/api/cron/analyze-broadcast-audio/route.ts",
	]) {
		const source = readFileSync(route, "utf8");
		assert.match(source, /startPipelineRunBestEffort/);
		assert.match(source, /settlePipelineRunBestEffort/);
	}
	console.log("✓ all six cron routes are structurally wired through the normalized best-effort lifecycle");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
