import { type NextRequest, NextResponse } from "next/server";
import { crawlAll } from "@/lib/historical-crawl";
import { jstToday } from "@/lib/historical-crawl/types";

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
	const summary = await crawlAll(date);

	const log = {
		event: "historical_broadcasts.crawl.summary",
		date,
		channels: Object.fromEntries(
			summary.results.map((r) => [
				r.channel,
				{
					ok: r.ok,
					count: r.rows.length,
					durationMs: r.durationMs,
					...(r.error ? { error: r.error } : {}),
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
	console.log(JSON.stringify(log));

	return NextResponse.json({ ok: true, ...log });
}
