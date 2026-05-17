import { type NextRequest, NextResponse } from "next/server";
import { refreshQVCMonthlyRange } from "@/lib/broadcasts/qvc-monthly";

export const maxDuration = 300;

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	return req.headers.get("authorization") === `Bearer ${secret}`;
}

function jstNow(): Date {
	return new Date(Date.now() + 9 * 3600 * 1000);
}

/**
 * Phase 1-B daily refresh of the QVC programme guide for the previous and
 * current calendar months. Upserts are idempotent, so this is safe to run
 * every day; the rolling window captures slots that QVC publishes ahead of
 * time once they roll into the current/next month.
 */
export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const start = Date.now();
	const summary = await refreshQVCMonthlyRange(jstNow());

	const log = {
		event: "qvc_monthly_refresh.summary",
		...summary,
		// trim long error arrays in logs but keep first few for context
		errors: summary.errors.slice(0, 5),
		droppedErrors: Math.max(0, summary.errors.length - 5),
		durationMs: Date.now() - start,
	};
	console.log(JSON.stringify(log));

	return NextResponse.json({ ok: true, ...log });
}
