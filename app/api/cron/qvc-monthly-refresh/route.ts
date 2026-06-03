import { type NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { refreshQVCMonthlyRange } from "@/lib/broadcasts/qvc-monthly";
import { getJSTYearMonth } from "@/lib/broadcasts/jst-date";
import { recoverQvcPending } from "@/lib/broadcasts/qvc-pending-recovery";
import { refreshShopChForwardRange } from "@/lib/broadcasts/shopch-forward";

// QVC monthly (~60 dates) + ShopCh forward (~15 dates) + recovery run
// sequentially; give the cron headroom beyond the 300s default.
export const maxDuration = 600;

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

	// ShopCh has no programme-guide month endpoint, but its programlist serves
	// future-day program IDs — pull today..+SHOPCH_FORWARD_DAYS so the calendar
	// shows upcoming ShopCh slots (the daily cron only scrapes yesterday).
	let shopchForward: Awaited<ReturnType<typeof refreshShopChForwardRange>> | { error: string };
	try {
		shopchForward = await refreshShopChForwardRange();
	} catch (err) {
		shopchForward = { error: err instanceof Error ? err.message : String(err) };
		console.warn("[qvc-monthly-refresh] refreshShopChForwardRange failed", shopchForward);
	}

	// This refresh is where freshly-published QVC slots get their category
	// attached (scrapeQVCForDate reads qvc_products.category). The daily
	// broadcasts cron runs recoverQvcPending an hour *earlier* (16:00 UTC),
	// so without this call a newly-categorised whitelist slot would sit in
	// 'pending' until the next day's daily cron — a perpetual ~24h archive
	// lag. Running it here flips those slots to 'queued' the same day so the
	// next archive-videos tick picks them up. Idempotent + CAS-guarded.
	let qvcRecovery: Awaited<ReturnType<typeof recoverQvcPending>> | { error: string };
	try {
		qvcRecovery = await recoverQvcPending();
	} catch (err) {
		qvcRecovery = { error: err instanceof Error ? err.message : String(err) };
		console.warn("[qvc-monthly-refresh] recoverQvcPending failed", qvcRecovery);
	}

	const log = {
		event: "qvc_monthly_refresh.summary",
		...summary,
		qvcRecovery,
		shopchForward,
		// trim long error arrays in logs but keep first few for context
		errors: summary.errors.slice(0, 5),
		droppedErrors: Math.max(0, summary.errors.length - 5),
		durationMs: Date.now() - start,
	};

	// Invalidate cache for previous + current JST month. Both are
	// rewritten by refreshQVCMonthlyRange's rolling window.
	try {
		const now = jstNow();
		const currentYM = getJSTYearMonth(now);
		// Pin day to 1 before decrementing month so setUTCMonth never overflows
		// into the wrong month on the 29th/30th/31st.
		const prevFirst = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		prevFirst.setUTCMonth(prevFirst.getUTCMonth() - 1);
		const prevYM = getJSTYearMonth(prevFirst);
		// ShopCh forward (today..+SHOPCH_FORWARD_DAYS) can write slots into next
		// month from ~mid-month onward — invalidate it too so the calendar's
		// next-month view is not stale for up to 6h.
		const nextFirst = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
		const nextYM = getJSTYearMonth(nextFirst);
		revalidateTag(`broadcasts:calendar:${prevYM}`, "max");
		revalidateTag(`broadcasts:calendar:${currentYM}`, "max");
		revalidateTag(`broadcasts:calendar:${nextYM}`, "max");
		revalidateTag("broadcasts:totals", "max");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[cache] revalidateTag failed", { route: "qvc-monthly-refresh", error: msg });
	}

	console.log(JSON.stringify(log));

	return NextResponse.json({ ok: true, ...log });
}
