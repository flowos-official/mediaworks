import { type NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { crawlAll } from "@/lib/historical-crawl";
import { jstToday } from "@/lib/historical-crawl/types";
import {
	finalizeRun,
	startRun,
	type PerChannelRunEntry,
	type RunStatus,
} from "@/lib/historical-crawl/runs";
import { maybeSendCrawlAlert, statusWithPersist } from "@/lib/historical-crawl/alert";
import { isDuplicateInvocation, invocationOrigin } from "@/lib/cron/duplicate-guard";
import { getServiceClient } from "@/lib/supabase";
import { createPipelineRunRepository, startPipelineRun } from "@/lib/intelligence/pipeline-run";

export const maxDuration = 300;

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode
	const header = req.headers.get("authorization");
	return header === "Bearer " + secret;
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const start = Date.now();
	const date = jstToday();

	// Every scheduled job here has been invoked twice, seconds apart, since at
	// least 2026-08 — scraping every source twice and paying for every AI call
	// twice. The two legitimate daily runs are eight hours apart, so anything
	// this close is the same trigger arriving again.
	const { data: lastRun } = await getServiceClient()
		.from("historical_crawl_runs")
		.select("run_at")
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (isDuplicateInvocation(lastRun?.run_at)) {
		console.warn(
			`[cron daily-historical-broadcasts] duplicate invocation from ${invocationOrigin()} — last run ${lastRun?.run_at}`,
		);
		return NextResponse.json({ ok: true, skipped: "duplicate-invocation", lastRunAt: lastRun?.run_at });
	}

	const runId = await startRun(date);
	const pipelineRun = await startPipelineRun(
		createPipelineRunRepository(getServiceClient()),
		{
			sourceType: "oa_channels",
			jobType: "historical_broadcast_crawl",
			externalRunId: runId,
			targetScope: { date },
		},
	).catch((err) => {
		console.warn("[cron daily-historical-broadcasts] pipeline run start failed:", err instanceof Error ? err.message : String(err));
		return null;
	});

	try {
		const summary = await crawlAll(date);
		const channels: PerChannelRunEntry[] = summary.results.map((r) => ({
			channel: r.channel,
			ok: r.ok,
			rowCount: r.rows.length,
			durationMs: r.durationMs,
			...(r.error ? { error: r.error } : {}),
		}));

		const parseStatus: RunStatus = summary.results.every((r) => r.ok)
			? "completed"
			: summary.results.some((r) => r.ok)
				? "partial"
				: "failed";

		// Parsing health says nothing about whether the rows landed. A run whose
		// upserts were all rejected used to record as `completed, upserted=0`,
		// which is how a 22-day OA outage went unnoticed in 2026-08.
		const persist = {
			totalRows: summary.totalRows,
			upserted: summary.persist.upserted,
			errors: summary.persist.errors,
			...(summary.persist.firstError ? { firstError: summary.persist.firstError } : {}),
		};
		const status = statusWithPersist(parseStatus, persist);
		const persistError =
			summary.persist.errors > 0
				? `persist: ${summary.persist.errors}/${summary.totalRows} rows failed` +
					(summary.persist.firstError ? ` — ${summary.persist.firstError}` : "")
				: summary.totalRows > 0 && summary.persist.upserted === 0
					? `persist: parsed ${summary.totalRows} rows but stored 0 with no error`
					: undefined;

		await finalizeRun({
			runId,
			status,
			totalRows: summary.totalRows,
			upserted: summary.persist.upserted,
			skippedDup: summary.persist.skippedDuplicate,
			channels,
			durationMs: Date.now() - start,
			...(persistError ? { error: persistError } : {}),
		});
		const pipelineCounts = {
			new: summary.persist.inserted,
			updated: summary.persist.updated,
			duplicate: summary.persist.skippedDuplicate,
			failed: summary.persist.errors + channels.filter((channel) => !channel.ok).length,
			processed: summary.totalRows,
		};
		if (pipelineRun) {
			if (status === "completed") {
				await pipelineRun.succeed(pipelineCounts).catch((recordErr) => {
					console.warn("[cron daily-historical-broadcasts] pipeline run finish failed:", recordErr instanceof Error ? recordErr.message : String(recordErr));
				});
			} else if (status === "partial") {
				await pipelineRun.partial(
					pipelineCounts,
					"crawl_partial",
					persistError ?? "One or more historical broadcast sources did not complete",
				).catch((recordErr) => {
					console.warn("[cron daily-historical-broadcasts] pipeline run finish failed:", recordErr instanceof Error ? recordErr.message : String(recordErr));
				});
			} else {
				await pipelineRun.heartbeat(pipelineCounts).catch((recordErr) => {
					console.warn("[cron daily-historical-broadcasts] pipeline run count record failed:", recordErr instanceof Error ? recordErr.message : String(recordErr));
				});
				await pipelineRun.fail(
					"crawl_failed",
					persistError ?? "Historical broadcast crawl failed for all sources",
				).catch((recordErr) => {
					console.warn("[cron daily-historical-broadcasts] pipeline run finish failed:", recordErr instanceof Error ? recordErr.message : String(recordErr));
				});
			}
		}

		// Keep the same console log shape so external log search continues to work.
		const log = {
			event: "historical_broadcasts.crawl.summary",
			runId,
			date,
			status,
			channels: Object.fromEntries(
				channels.map((c) => [
					c.channel,
					{
						ok: c.ok,
						count: c.rowCount,
						durationMs: c.durationMs,
						...(c.error ? { error: c.error } : {}),
					},
				]),
			),
			totals: {
				rowsCollected: summary.totalRows,
				upserted: summary.persist.upserted,
				skippedDuplicate: summary.persist.skippedDuplicate,
				errors: summary.persist.errors,
			},
			durationMs: Date.now() - start,
		};

		// Invalidate /broadcasts page cache for the scraped JST month.
		try {
			const ym = date.slice(0, 7); // date is "YYYY-MM-DD" from jstToday()
			revalidateTag(`broadcasts:calendar:${ym}`, "max");
			revalidateTag("broadcasts:totals", "max");
			revalidateTag("discovery:category-distribution", "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", { route: "daily-historical-broadcasts", error: msg });
		}

		console.log(JSON.stringify(log));

		// Proactive ops alert (PUSH): ping ALERT_WEBHOOK_URL on a partial run, a
		// channel that errored, or a channel whose row count dropped below 50% of
		// its 7-day median. Silent when healthy. Best-effort — an alert failure
		// must never break the crawl, so it is fully wrapped.
		try {
			const r = await maybeSendCrawlAlert({ jstDate: date, status, channels, persist });
			if (r.alerts.length > 0 && !r.sent) {
				console.warn(
					`[cron daily-historical-broadcasts] alert not sent (${r.skippedReason ?? r.error}): ${r.alerts.length} condition(s)`,
				);
			}
		} catch (err) {
			console.warn(
				"[cron daily-historical-broadcasts] alert failed:",
				err instanceof Error ? err.message : String(err),
			);
		}

		return NextResponse.json({ ok: true, ...log });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (pipelineRun) {
			await pipelineRun.fail("crawl_failed", msg).catch((recordErr) => {
				console.warn("[cron daily-historical-broadcasts] pipeline run failure record failed:", recordErr instanceof Error ? recordErr.message : String(recordErr));
			});
		}
		await finalizeRun({
			runId,
			status: "failed",
			totalRows: 0,
			upserted: 0,
			skippedDup: 0,
			channels: [],
			durationMs: Date.now() - start,
			error: msg.slice(0, 500),
		});
		console.error("[cron daily-historical-broadcasts] failed:", msg);

		// Alert on total failure too — there are no per-channel rows here, so this
		// fires a single run_failed ping. Best-effort, never rethrows.
		try {
			await maybeSendCrawlAlert({ jstDate: date, status: "failed", channels: [] });
		} catch (alertErr) {
			console.warn(
				"[cron daily-historical-broadcasts] failure-alert failed:",
				alertErr instanceof Error ? alertErr.message : String(alertErr),
			);
		}

		return NextResponse.json(
			{ ok: false, runId, error: msg },
			{ status: 500 },
		);
	}
}
