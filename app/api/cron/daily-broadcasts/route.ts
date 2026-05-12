import { type NextRequest, NextResponse } from "next/server";
import { scrapeAllForDate } from "@/lib/broadcasts";
import { enrichQvcProducts } from "@/lib/qvc-products/enrich";

export const maxDuration = 60;

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

function getYesterdayJST(nowUtc: Date): Date {
	// JST = UTC + 9. Shift to JST clock, then go back 1 day.
	const jstMs = nowUtc.getTime() + 9 * 3600 * 1000;
	const jstNow = new Date(jstMs);
	jstNow.setUTCDate(jstNow.getUTCDate() - 1);
	return new Date(
		Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()),
	);
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const start = Date.now();
	const target = getYesterdayJST(new Date());
	const targetIso = target.toISOString().slice(0, 10);

	const summary = await scrapeAllForDate(target);

	// Enrich QVC products for just the day we scraped. Typical QVC slot has 1-10
	// products → ~50-100 unique IDs per day, well under maxDuration=60s at concurrency=3.
	const enrich = await enrichQvcProducts({
		onlyDates: [targetIso],
		concurrency: 3,
		// onProgress intentionally omitted to keep cron logs short
	});

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
		durationMs: Date.now() - start,
	};
	console.log(JSON.stringify(log));

	return NextResponse.json({ ok: true, ...log });
}
