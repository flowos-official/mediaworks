import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	returnAfterPipelineFailure,
	failPipelineRunWithKnownCounts,
	settlePipelineRunBestEffort,
	startPipelineRunBestEffort,
	throwAfterPipelineFailure,
} from "../lib/intelligence/pipeline-run-route";
import type { PipelineRunHandle, PipelineRunRepository } from "../lib/intelligence/pipeline-run";
import { discoveryHomePipelineCounts } from "../app/api/cron/daily-discovery-home/route";
import { discoveryLivePipelineCounts } from "../app/api/cron/daily-discovery-live/route";
import { dailyBroadcastPipelineCounts } from "../app/api/cron/daily-broadcasts/route";
import { historicalBroadcastPipelineCounts } from "../app/api/cron/daily-historical-broadcasts/route";
import { archiveVideosPipelineOutcome, archiveVideosQueryFailure } from "../app/api/cron/archive-videos/route";
import { broadcastAudioPipelineOutcome, broadcastAudioQueryFailure } from "../app/api/cron/analyze-broadcast-audio/route";

const input = {
	sourceType: "test",
	jobType: "test_job",
	externalRunId: "route-contract",
	targetScope: {},
};

async function main() {
	{
		assert.deepEqual(discoveryHomePipelineCounts(4, 1), { new: 1, updated: 0, duplicate: 3, failed: 0, processed: 4 });
		assert.deepEqual(discoveryLivePipelineCounts(0, 0), { new: 0, updated: 0, duplicate: 0, failed: 0, processed: 0 });
		assert.deepEqual(dailyBroadcastPipelineCounts({ inserted: 1, updated: 2, sourceErrors: 1, enrichmentErrors: 1, processed: 5 }), { new: 1, updated: 2, duplicate: 0, failed: 2, processed: 5 });
		assert.deepEqual(historicalBroadcastPipelineCounts({ inserted: 1, updated: 2, skippedDuplicate: 3, persistErrors: 1, failedChannels: 1, processed: 7 }), { new: 1, updated: 2, duplicate: 3, failed: 2, processed: 7 });
		assert.equal(archiveVideosPipelineOutcome({ processed: 1, archived: 0, queued: 0, abandoned: 0, deferred: 1, failed_unsupported: 0, stale_requeued: 0, stale_abandoned: 0 }, 0).status, "partial");
		assert.equal(broadcastAudioPipelineOutcome({ recovered: 0, seeded: 1, processed: 0, done: 0, queued: 0, failed: 0, skipped: 0 }, 0).counts.new, 1);
		console.log("✓ all six production route-owned mapping functions execute representative outcomes");
	}

	{
		const rejectingRun: PipelineRunHandle = {
			id: "early-return",
			heartbeat: async () => undefined,
			succeed: async () => undefined,
			partial: async () => undefined,
			fail: async () => { throw new Error("recorder unavailable"); },
		};
		const archiveResponse = { status: 500, route: "archive" };
		const audioResponse = { status: 500, route: "audio" };
		assert.equal(await archiveVideosQueryFailure(rejectingRun, "query failed", archiveResponse, () => undefined), archiveResponse);
		assert.equal(await broadcastAudioQueryFailure(rejectingRun, "query failed", audioResponse, () => undefined), audioResponse);
		console.log("✓ archive and audio route-owned early-return boundaries preserve primary response identity");
	}

	{
		const events: string[] = [];
		const heartbeatFails: PipelineRunHandle = {
			id: "run-heartbeat-fails",
			heartbeat: async () => { events.push("heartbeat"); throw new Error("heartbeat unavailable"); },
			succeed: async () => undefined,
			partial: async () => undefined,
			fail: async () => { events.push("fail"); },
		};
		await failPipelineRunWithKnownCounts(heartbeatFails, { processed: 2 }, "source_failed", "failed", () => undefined);
		assert.deepEqual(events, ["heartbeat", "fail"]);
		const bothFail: PipelineRunHandle = { ...heartbeatFails, id: "run-both-fail", fail: async () => { events.push("fail-rejected"); throw new Error("fail unavailable"); } };
		await failPipelineRunWithKnownCounts(bothFail, { processed: 2 }, "source_failed", "failed", () => undefined);
		assert.deepEqual(events, ["heartbeat", "fail", "heartbeat", "fail-rejected"]);
		console.log("✓ failure settlement attempts terminal fail even when heartbeat or terminal recording rejects");
	}

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
