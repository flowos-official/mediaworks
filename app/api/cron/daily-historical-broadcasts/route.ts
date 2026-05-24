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
	const runId = await startRun(date);

	try {
		const summary = await crawlAll(date);
		const channels: PerChannelRunEntry[] = summary.results.map((r) => ({
			channel: r.channel,
			ok: r.ok,
			rowCount: r.rows.length,
			durationMs: r.durationMs,
			...(r.error ? { error: r.error } : {}),
		}));

		const status: RunStatus = summary.results.every((r) => r.ok)
			? "completed"
			: summary.results.some((r) => r.ok)
				? "partial"
				: "failed";

		await finalizeRun({
			runId,
			status,
			totalRows: summary.totalRows,
			upserted: summary.persist.upserted,
			skippedDup: summary.persist.skippedDuplicate,
			channels,
			durationMs: Date.now() - start,
		});

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

		return NextResponse.json({ ok: true, ...log });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
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
		return NextResponse.json(
			{ ok: false, runId, error: msg },
			{ status: 500 },
		);
	}
}
