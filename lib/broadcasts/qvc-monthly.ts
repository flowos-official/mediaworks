/**
 * Phase 1-B: monthly refresh helper for QVC.
 *
 * Re-scrapes the previous month + current month in one pass (~60 dates).
 * The site exposes the next month near the end of the current month — this
 * helper picks it up naturally on the day the URL becomes valid because the
 * "current month" window expands as the calendar rolls forward.
 *
 * Upserts are idempotent (broadcasts table uses channel,air_date,start_time
 * as the conflict key), so running daily over the same window is cheap and
 * safe. Category filtering happens inside scrapeQVCForDate (Phase 1-C).
 */
import { upsertBroadcasts } from "./persist";
import { scrapeQVCForDate } from "./qvc";
import { shouldReconcileDate, reconcileFutureSlots } from "./reconcile";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Returns every JST calendar date in [previous month, current month] for the
 * given anchor day. Anchor is treated as a JST date.
 */
export function getMonthlyRefreshDates(today: Date): Date[] {
	const y = today.getUTCFullYear();
	const m = today.getUTCMonth() + 1; // 1-12
	const prevY = m === 1 ? y - 1 : y;
	const prevM = m === 1 ? 12 : m - 1;
	const lastPrev = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
	const lastCurr = new Date(Date.UTC(y, m, 0)).getUTCDate();

	const dates: Date[] = [];
	for (let d = 1; d <= lastPrev; d++) {
		dates.push(new Date(Date.UTC(prevY, prevM - 1, d)));
	}
	for (let d = 1; d <= lastCurr; d++) {
		dates.push(new Date(Date.UTC(y, m - 1, d)));
	}
	return dates;
}

export interface MonthlyRefreshSummary {
	dates: number;
	succeeded: number;
	failed: number;
	totalSlots: number;
	inserted: number;
	updated: number;
	reconciledDeleted: number;
	errors: Array<{ date: string; error: string }>;
}

/**
 * Sequentially re-scrape QVC for each date in the prev+current month window.
 * Sequential (not parallel) so politeFetch's natural pacing keeps the QVC
 * site happy; the full pass typically fits within maxDuration=300s.
 */
export async function refreshQVCMonthlyRange(
	today: Date,
): Promise<MonthlyRefreshSummary> {
	const dates = getMonthlyRefreshDates(today);
	let succeeded = 0;
	let failed = 0;
	let totalSlots = 0;
	let inserted = 0;
	let updated = 0;
	let reconciledDeleted = 0;
	const todayIso = `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}-${pad2(today.getUTCDate())}`;
	const errors: Array<{ date: string; error: string }> = [];

	for (const date of dates) {
		const iso = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
		try {
			const result = await scrapeQVCForDate(date);
			if (!result.ok) {
				failed += 1;
				errors.push({ date: iso, error: result.error ?? "unknown" });
				continue;
			}
			succeeded += 1;
			if (result.slots.length > 0) {
				const persist = await upsertBroadcasts(result.slots);
				totalSlots += result.slots.length;
				inserted += persist.inserted;
				updated += persist.updated;
				if (shouldReconcileDate(iso, todayIso, result.slots.length)) {
					reconciledDeleted += await reconcileFutureSlots(
						"qvc",
						iso,
						result.slots.map((s) => s.start_time),
					);
				}
				if (persist.errors.length > 0) {
					errors.push({
						date: iso,
						error: `persist: ${persist.errors[0].error}`,
					});
				}
			}
		} catch (e) {
			failed += 1;
			errors.push({
				date: iso,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	return {
		dates: dates.length,
		succeeded,
		failed,
		totalSlots,
		inserted,
		updated,
		reconciledDeleted,
		errors,
	};
}
