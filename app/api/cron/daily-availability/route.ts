/**
 * Daily availability + price snapshot cron.
 *
 * Runs once a day after broadcasts/discovery crons. For each discovered_products
 * row (oldest last_seen_at first):
 *   - HEAD request to product_url
 *   - 200/3xx → mark available + bump last_seen_at
 *   - 404/410 → mark is_still_available = false
 *   - Always inserts a daily product_snapshots row (price/availability baseline)
 *
 * Limit is set via env (default 500/run) so each invocation fits comfortably
 * inside maxDuration. Subsequent days catch up the rest naturally because we
 * order by oldest last_seen_at first.
 */
import { type NextRequest, NextResponse } from "next/server";
import { checkAvailability } from "@/lib/discovery/availability-check";

export const maxDuration = 300;

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

	const limit = Number(process.env.AVAILABILITY_CHECK_LIMIT ?? "500");
	const concurrency = Number(process.env.AVAILABILITY_CHECK_CONCURRENCY ?? "6");
	const start = Date.now();

	const result = await checkAvailability({
		limit,
		concurrency,
	});

	const log = {
		event: "availability.check.summary",
		ranAt: new Date().toISOString(),
		limit,
		concurrency,
		...result,
		durationMs: Date.now() - start,
	};
	console.log(JSON.stringify(log));

	return NextResponse.json({ ok: true, ...log });
}
