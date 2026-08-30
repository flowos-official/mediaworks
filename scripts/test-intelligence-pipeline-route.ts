import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	returnAfterPipelineFailure,
	failPipelineRunWithKnownCounts,
	settlePipelineRunBestEffort,
	startPipelineRunBestEffort,
} from "../lib/intelligence/pipeline-run-route";
import type { PipelineRunHandle, PipelineRunRepository } from "../lib/intelligence/pipeline-run";
import { discoveryHomePipelineCounts } from "../app/api/cron/daily-discovery-home/route";
import { discoveryLivePipelineCounts } from "../app/api/cron/daily-discovery-live/route";
import {
	dailyBroadcastPipelineCounts,
	dailyBroadcastPipelineOutcome,
} from "../app/api/cron/daily-broadcasts/route";
import {
	historicalBroadcastClassificationOutcome,
	historicalBroadcastPipelineCounts,
} from "../app/api/cron/daily-historical-broadcasts/route";
import {
	archiveVideosPipelineOutcome,
	archiveVideosQueryFailure,
	archiveVideosThrownFailure,
} from "../app/api/cron/archive-videos/route";
import {
	broadcastAudioPipelineOutcome,
	broadcastAudioQueryFailure,
	broadcastAudioThrownFailure,
} from "../app/api/cron/analyze-broadcast-audio/route";

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
		assert.deepEqual(dailyBroadcastPipelineCounts({ inserted: 1, updated: 2, sourceErrors: 1, persistenceErrors: 0, enrichmentErrors: 1, snapshotErrors: 3, processed: 5 }), { new: 1, updated: 2, duplicate: 0, failed: 5, processed: 5 });
		assert.deepEqual(historicalBroadcastPipelineCounts({ inserted: 1, updated: 2, skippedDuplicate: 3, persistErrors: 1, failedChannels: 1, processed: 7 }), { new: 1, updated: 2, duplicate: 3, failed: 2, processed: 7 });
		const unclassifiedCounts = historicalBroadcastPipelineCounts({ inserted: undefined, updated: undefined, skippedDuplicate: 3, persistErrors: 0, failedChannels: 0, processed: 7 });
		assert.deepEqual(
			unclassifiedCounts,
			{ duplicate: 3, failed: 0, processed: 7 },
			"unclassified persisted rows omit unknown new/updated keys from normalized telemetry",
		);
		assert.deepEqual(
			historicalBroadcastClassificationOutcome({ counts: unclassifiedCounts, unclassified: 2, classificationError: "classification unavailable", domainStatus: "completed" }),
			{
				status: "partial",
				counts: { duplicate: 3, failed: 0, processed: 7 },
				errorCode: "persist_classification_unavailable",
				errorSummary: "2 persisted row(s) could not be classified as inserted or updated: classification unavailable",
			},
			"the rows were upserted; only the inserted-vs-updated split is unknown, so the run is degraded rather than failed",
		);
		// The pipeline row is a projection of the domain row and must never be
		// worse than it. Reporting `failed` here made data_pipeline_runs and
		// historical_crawl_runs contradict each other over the same execution.
		for (const domainStatus of ["partial", "failed"] as const) {
			assert.equal(
				historicalBroadcastClassificationOutcome({ counts: unclassifiedCounts, unclassified: 2, domainStatus }),
				null,
				`a ${domainStatus} crawl keeps its own status and message`,
			);
		}
		const snapshotFailure = dailyBroadcastPipelineOutcome({
			inserted: 4,
			updated: 1,
			persistenceErrors: 0,
			sourceFailures: [],
			enrichmentErrors: 0,
			processed: 5,
			successfulSources: 2,
			totalSources: 2,
			snapshotErrors: [
				{ channel: "qvc", operation: "category_backfill", broadcastId: "qvc-1", message: "category write unavailable" },
				{ channel: "shopch", operation: "video_status_update", broadcastId: "shopch-1", message: "video write unavailable" },
			],
		});
		assert.equal(snapshotFailure.status, "partial", "a snapshot data-path write failure cannot be normalized as success");
		assert.equal(snapshotFailure.counts.failed, 2);
		assert.equal(snapshotFailure.errorCode, "snapshot_enrichment_partial");
		assert.match(snapshotFailure.errorSummary ?? "", /category_backfill.*category write unavailable/);
		assert.match(snapshotFailure.errorSummary ?? "", /video_status_update.*video write unavailable/);
		// With no source results at all, successfulSources === totalSources === 0
		// satisfied the success test and a total scraper outage recorded green,
		// while the `successfulSources === 0` branch was never reached.
		const noSourcesObserved = dailyBroadcastPipelineOutcome({
			inserted: 0,
			updated: 0,
			persistenceErrors: 0,
			sourceFailures: [],
			enrichmentErrors: 0,
			processed: 0,
			successfulSources: 0,
			totalSources: 0,
			snapshotErrors: [],
		});
		assert.equal(noSourcesObserved.status, "failed", "observing no sources at all is an outage, not a clean night");
		assert.equal(noSourcesObserved.errorCode, "no_sources_observed");

		const qvcParserError = `unexpected QVC schedule markup ${"x".repeat(200)} END_OF_UNBOUNDED_ERROR`;
		const mixedSourceFailure = dailyBroadcastPipelineOutcome({
			inserted: 3,
			updated: 1,
			persistenceErrors: 0,
			sourceFailures: [{ channel: "qvc", error: qvcParserError }],
			enrichmentErrors: 0,
			processed: 4,
			successfulSources: 1,
			totalSources: 2,
			snapshotErrors: [],
		});
		const mixedSourceAndPersistenceFailure = dailyBroadcastPipelineOutcome({
			inserted: 2,
			updated: 0,
			persistenceErrors: 2,
			sourceFailures: [{ channel: "qvc", error: "QVC parser returned no schedule rows" }],
			enrichmentErrors: 0,
			processed: 2,
			successfulSources: 1,
			totalSources: 2,
			snapshotErrors: [],
		});
		const allSourcesFailed = dailyBroadcastPipelineOutcome({
			inserted: 0,
			updated: 0,
			persistenceErrors: 0,
			sourceFailures: [
				{ channel: "shopch", error: "Shop Channel upstream timeout" },
				{ channel: "qvc", error: "QVC markup changed" },
			],
			enrichmentErrors: 0,
			processed: 0,
			successfulSources: 0,
			totalSources: 2,
			snapshotErrors: [],
		});
		assert.deepEqual(
			[
				{
					status: mixedSourceFailure.status,
					failed: mixedSourceFailure.counts.failed,
					errorCode: mixedSourceFailure.errorCode,
					hasSourceContext: /qvc: unexpected QVC schedule markup/.test(mixedSourceFailure.errorSummary ?? ""),
					claimsZeroSourceErrors: /0 source scrape error/.test(mixedSourceFailure.errorSummary ?? ""),
					leaksUnboundedTail: /END_OF_UNBOUNDED_ERROR/.test(mixedSourceFailure.errorSummary ?? ""),
				},
				{
					status: mixedSourceAndPersistenceFailure.status,
					failed: mixedSourceAndPersistenceFailure.counts.failed,
					errorCode: mixedSourceAndPersistenceFailure.errorCode,
					hasSourceContext: /qvc: QVC parser returned no schedule rows/.test(mixedSourceAndPersistenceFailure.errorSummary ?? ""),
					hasPersistenceCount: /2 broadcast persistence error/.test(mixedSourceAndPersistenceFailure.errorSummary ?? ""),
				},
				{
					status: allSourcesFailed.status,
					failed: allSourcesFailed.counts.failed,
					errorCode: allSourcesFailed.errorCode,
					hasShopChContext: /shopch: Shop Channel upstream timeout/.test(allSourcesFailed.errorSummary ?? ""),
					hasQvcContext: /qvc: QVC markup changed/.test(allSourcesFailed.errorSummary ?? ""),
				},
			],
			[
				{
					status: "partial",
					failed: 1,
					errorCode: "source_partial",
					hasSourceContext: true,
					claimsZeroSourceErrors: false,
					leaksUnboundedTail: false,
				},
				{
					status: "partial",
					failed: 3,
					errorCode: "source_partial",
					hasSourceContext: true,
					hasPersistenceCount: true,
				},
				{
					status: "failed",
					failed: 2,
					errorCode: "source_failed",
					hasShopChContext: true,
					hasQvcContext: true,
				},
			],
			"source/parser failures are counted and bounded separately from persistence failures",
		);
		assert.equal(
			archiveVideosPipelineOutcome({ processed: 1, archived: 0, queued: 0, abandoned: 0, deferred: 1, failed_unsupported: 0, stale_requeued: 0, stale_abandoned: 0 }, 0).status,
			"succeeded",
			"a slot with no video is deferred by design, which is a normal night rather than a degraded one",
		);
		assert.equal(
			archiveVideosPipelineOutcome({ processed: 1, archived: 0, queued: 0, abandoned: 1, deferred: 0, failed_unsupported: 0, stale_requeued: 0, stale_abandoned: 0 }, 0).status,
			"partial",
			"an abandoned slot is a real failure and still degrades the run",
		);
		assert.equal(broadcastAudioPipelineOutcome({ recovered: 0, seeded: 1, processed: 0, done: 0, queued: 0, failed: 0, skipped: 0 }, 0).counts.updated, 1);
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
		console.log("✓ handled query failure keeps the original response when recorder failure recording fails");
	}

	for (const boundary of [
		{
			name: "archive",
			invoke: archiveVideosThrownFailure,
			errorCode: "video_archive_failed",
		},
		{
			name: "audio",
			invoke: broadcastAudioThrownFailure,
			errorCode: "audio_analysis_failed",
		},
	] as const) {
		let heartbeatAttempts = 0;
		const failCalls: Array<{ errorCode: string; summary: string }> = [];
		const recorderError = new Error(`${boundary.name} recorder unavailable`);
		const reports: Array<{ phase: "start" | "settle"; error: unknown }> = [];
		const run: PipelineRunHandle = {
			id: `${boundary.name}-thrown-failure`,
			heartbeat: async () => {
				heartbeatAttempts++;
				throw new Error(`${boundary.name} heartbeat unavailable`);
			},
			succeed: async () => undefined,
			partial: async () => undefined,
			fail: async (errorCode, summary) => {
				failCalls.push({ errorCode, summary });
				throw recorderError;
			},
		};
		const primaryError = new Error(`${boundary.name} primary failure`);

		await assert.rejects(
			() => boundary.invoke(run, primaryError, (phase, error) => reports.push({ phase, error })),
			(error: unknown) => error === primaryError,
		);
		assert.equal(heartbeatAttempts, 0);
		assert.deepEqual(failCalls, [
			{ errorCode: boundary.errorCode, summary: primaryError.message },
		]);
		assert.equal(reports.length, 1);
		assert.equal(reports[0]?.phase, "settle");
		assert.equal(reports[0]?.error, recorderError);
	}
	console.log("✓ archive and audio production thrown-failure boundaries preserve primary error identity after one rejected terminal attempt");

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
