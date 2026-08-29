import { type NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { scrapeAllForDate } from "@/lib/broadcasts";
import { enrichQvcProducts } from "@/lib/qvc-products/enrich";
import { getServiceClient } from "@/lib/supabase";
import { loadWhitelist } from "@/lib/broadcasts/category-filter";
import { getYesterdayJST, getJSTYearMonth } from "@/lib/broadcasts/jst-date";
import {
	enrichQvcSlotSnapshots as enrichQvcSlotSnapshotsWithOutcome,
	enrichShopChSlotSnapshots as enrichShopChSlotSnapshotsWithOutcome,
	type DailySnapshotEnrichmentError,
} from "@/lib/broadcasts/daily-snapshot-enrichment";
import { createPipelineRunRepository } from "@/lib/intelligence/pipeline-run";
import { failPipelineRunWithKnownCounts, settlePipelineRunBestEffort, startPipelineRunBestEffort } from "@/lib/intelligence/pipeline-run-route";
export const maxDuration = 180;

export function dailyBroadcastPipelineCounts(input: {
	inserted: number;
	updated: number;
	sourceErrors: number;
	persistenceErrors: number;
	enrichmentErrors: number;
	snapshotErrors: number;
	processed: number;
}) {
	return {
		new: input.inserted,
		updated: input.updated,
		duplicate: 0,
		failed: input.sourceErrors + input.persistenceErrors + input.enrichmentErrors + input.snapshotErrors,
		processed: input.processed,
	};
}

export function dailyBroadcastPipelineOutcome(input: {
	inserted: number;
	updated: number;
	persistenceErrors: number;
	sourceFailures: Array<{ channel: string; error?: string }>;
	enrichmentErrors: number;
	processed: number;
	successfulSources: number;
	totalSources: number;
	snapshotErrors: DailySnapshotEnrichmentError[];
}) {
	const counts = dailyBroadcastPipelineCounts({
		inserted: input.inserted,
		updated: input.updated,
		sourceErrors: input.sourceFailures.length,
		persistenceErrors: input.persistenceErrors,
		enrichmentErrors: input.enrichmentErrors,
		snapshotErrors: input.snapshotErrors.length,
		processed: input.processed,
	});
	if (counts.failed === 0 && input.successfulSources === input.totalSources) {
		return { status: "succeeded" as const, counts };
	}
	const snapshotSummary = input.snapshotErrors
		.map((error) => `${error.channel}/${error.operation}${error.broadcastId ? `(${error.broadcastId})` : ""}: ${error.message}`)
		.join("; ");
	const sourceSummary = input.sourceFailures
		.map((failure) => `${failure.channel}: ${(failure.error?.trim() || "source returned not-ok").slice(0, 160)}`)
		.join("; ");
	const errorSummary = [
		`${input.sourceFailures.length} source scrape error(s)${sourceSummary ? `: ${sourceSummary}` : ""}`,
		`${input.persistenceErrors} broadcast persistence error(s)`,
		`${input.enrichmentErrors} QVC product enrichment error(s)`,
		`${input.snapshotErrors.length} snapshot enrichment error(s)`,
		snapshotSummary,
	].filter(Boolean).join("; ");
	if (input.successfulSources === 0) {
		return { status: "failed" as const, counts, errorCode: "source_failed", errorSummary };
	}
	return {
		status: "partial" as const,
		counts,
		errorCode: input.sourceFailures.length > 0
			? "source_partial"
			: input.snapshotErrors.length > 0
				? "snapshot_enrichment_partial"
				: "enrichment_partial",
		errorSummary,
	};
}

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const start = Date.now();
	const target = getYesterdayJST(new Date());
	const targetIso = target.toISOString().slice(0, 10);
	const reportPipelineRunError = (phase: "start" | "settle", error: unknown) => {
		console.warn(`[cron daily-broadcasts] pipeline run ${phase} failed:`, error instanceof Error ? error.message : String(error));
	};
	const pipelineRun = await startPipelineRunBestEffort(
		createPipelineRunRepository(getServiceClient()),
		{
			sourceType: "qvc_shopch",
			jobType: "broadcast_schedule",
			externalRunId: `${targetIso}:${crypto.randomUUID()}`,
			targetScope: { date: targetIso },
		},
		reportPipelineRunError,
	);

	try {

	const summary = await scrapeAllForDate(target);

	// Enrich QVC products for just the day we scraped. Typical QVC slot has 1-10
	// products → ~50-100 unique IDs per day, well under maxDuration=120s at concurrency=3.
	const enrich = await enrichQvcProducts({
		onlyDates: [targetIso],
		concurrency: 3,
		// onProgress intentionally omitted to keep cron logs short
	});

	// Snapshot enrichment: wire broadcast_products + brand attribution.
	// Load whitelist once; only enrich whitelist-matching slots.
	const whitelist = await loadWhitelist();

	const qvcResult = summary.results.find((r) => r.channel === "qvc");
	const shopchResult = summary.results.find((r) => r.channel === "shopch");

	const qvcSnapshot = qvcResult?.ok
		? await enrichQvcSlotSnapshotsWithOutcome(
				qvcResult.slots as Array<{ channel: string; air_date: string; start_time: string; product_ids: string[] | null; category: string | null }>,
				summary.broadcastIds,
				whitelist,
			)
		: { snapshotRows: 0, brandUpdates: 0, videoQueued: 0, videoDeferred: 0, categoryBackfilled: 0, errors: [] };

	const shopchSnapshot = shopchResult?.ok && shopchResult.shopchMetadataByProgramId
		? await enrichShopChSlotSnapshotsWithOutcome(
				shopchResult.slots as Array<{ channel: string; air_date: string; start_time: string; category: string | null }>,
				shopchResult.shopchMetadataByProgramId,
				summary.broadcastIds,
				whitelist,
			)
		: { snapshotRows: 0, brandUpdates: 0, videoQueued: 0, videoDeferred: 0, categoryBackfilled: 0, errors: [] };
	const snapshotErrors = [...qvcSnapshot.errors, ...shopchSnapshot.errors];

	const log = {
		event: "broadcasts.scrape.summary",
		date: targetIso,
		channels: Object.fromEntries(
			summary.results.map((r) => [
				r.channel,
				{
					ok: r.ok,
					count: r.slots.length,
					...(r.error ? { error: r.error } : {}),
					coverage: r.health.fieldCoverage,
				},
			]),
		),
		totals: {
			inserted: summary.totalInserted,
			updated: summary.totalUpdated,
			errors: summary.totalErrors,
		},
		qvcProductEnrichment: {
			candidates: enrich.candidates,
			fetched: enrich.fetched,
			failed: enrich.failed,
		},
		snapshotEnrichment: {
			qvc: {
				snapshotRows: qvcSnapshot.snapshotRows,
				brandUpdates: qvcSnapshot.brandUpdates,
				videoQueued: qvcSnapshot.videoQueued,
				videoDeferred: qvcSnapshot.videoDeferred,
				categoryBackfilled: qvcSnapshot.categoryBackfilled,
				errors: qvcSnapshot.errors,
			},
			shopch: {
				snapshotRows: shopchSnapshot.snapshotRows,
				brandUpdates: shopchSnapshot.brandUpdates,
				videoQueued: shopchSnapshot.videoQueued,
				videoDeferred: shopchSnapshot.videoDeferred,
				errors: shopchSnapshot.errors,
			},
		},
		durationMs: Date.now() - start,
	};

	// Invalidate page cache for the month we just wrote to. revalidateTag
	// failures are non-fatal — the cron's job is data ingest; stale cache
	// recovers via cacheLife's 6h revalidate fallback.
	try {
		const ym = getJSTYearMonth(target);
		revalidateTag(`broadcasts:calendar:${ym}`, "max");
		revalidateTag("broadcasts:totals", "max");
		revalidateTag("discovery:category-distribution", "max");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[cache] revalidateTag failed", { route: "daily-broadcasts", error: msg });
	}

	console.log(JSON.stringify(log));
	const pipelineOutcome = dailyBroadcastPipelineOutcome({
		inserted: summary.totalInserted,
		updated: summary.totalUpdated,
		persistenceErrors: summary.totalErrors,
		sourceFailures: summary.results
			.filter((result) => !result.ok)
			.map((result) => ({ channel: result.channel, error: result.error })),
		enrichmentErrors: enrich.failed,
		snapshotErrors,
		processed: summary.results.reduce((total, result) => total + result.slots.length, 0),
		successfulSources: summary.results.filter((result) => result.ok).length,
		totalSources: summary.results.length,
	});
	await settlePipelineRunBestEffort(
		pipelineRun,
		async (run) => {
		if (pipelineOutcome.status === "succeeded") {
			await run.succeed(pipelineOutcome.counts);
		} else if (pipelineOutcome.status === "partial") {
			await run.partial(
					pipelineOutcome.counts,
					pipelineOutcome.errorCode,
					pipelineOutcome.errorSummary,
				);
		} else {
			await failPipelineRunWithKnownCounts(run, pipelineOutcome.counts, pipelineOutcome.errorCode, pipelineOutcome.errorSummary, reportPipelineRunError);
		}
		},
		reportPipelineRunError,
	);

	return NextResponse.json({ ok: true, ...log });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await settlePipelineRunBestEffort(pipelineRun, (run) => run.fail("broadcast_schedule_failed", message), reportPipelineRunError);
		throw err;
	}
}
