/**
 * ShopCh forward refresh. The daily cron only scrapes "yesterday", so today and
 * upcoming ShopCh slots never appear on the calendar. shopch.jp's programlist
 * DOES serve future-day program IDs (verified 2026-06-02: each onAirDay request
 * returns that day's IDs, ~24-26/day), so we re-use scrapeShopChannelForDate
 * per forward date. Slots arrive with category populated from JSON pgmcategory,
 * so the whitelist gate works without extra enrichment. Video archival is NOT
 * needed forward — it runs only on air_date <= today via the daily flow.
 *
 * Runtime is assumed UTC (Vercel), matching scrapeShopChannelForDate's date
 * handling and the rest of the broadcast crons.
 */
import { scrapeShopChannelForDate } from "./shopch";
import { upsertBroadcasts } from "./persist";
import { shouldReconcileDate, reconcileFutureSlots } from "./reconcile";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function isoOf(date: Date): string {
	return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * JST-today .. JST-today+daysAhead as UTC-midnight Dates (inclusive of today).
 * `todayJst` is a Date whose UTC y/m/d are the JST calendar day (as produced by
 * `new Date(Date.now() + 9*3600*1000)`).
 */
export function getForwardDates(todayJst: Date, daysAhead: number): Date[] {
	const y = todayJst.getUTCFullYear();
	const m = todayJst.getUTCMonth();
	const d = todayJst.getUTCDate();
	const dates: Date[] = [];
	for (let i = 0; i <= daysAhead; i++) {
		dates.push(new Date(Date.UTC(y, m, d + i)));
	}
	return dates;
}

export interface ShopChForwardSummary {
	dates: number;
	succeeded: number;
	failed: number;
	totalSlots: number;
	inserted: number;
	updated: number;
	reconciledDeleted: number;
	errors: Array<{ date: string; error: string }>;
}

export async function refreshShopChForwardRange(
	daysAhead = Number(process.env.SHOPCH_FORWARD_DAYS ?? 14),
	todayJst: Date = new Date(Date.now() + 9 * 3600 * 1000),
): Promise<ShopChForwardSummary> {
	const dates = getForwardDates(todayJst, daysAhead);
	const todayIso = isoOf(todayJst);
	let succeeded = 0;
	let failed = 0;
	let totalSlots = 0;
	let inserted = 0;
	let updated = 0;
	let reconciledDeleted = 0;
	const errors: Array<{ date: string; error: string }> = [];

	for (const date of dates) {
		const iso = isoOf(date);
		try {
			const result = await scrapeShopChannelForDate(date);
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
						"shopch",
						iso,
						result.slots.map((s) => s.start_time),
					);
				}
				if (persist.errors.length > 0) {
					errors.push({ date: iso, error: `persist: ${persist.errors[0].error}` });
				}
			}
		} catch (e) {
			failed += 1;
			errors.push({ date: iso, error: e instanceof Error ? e.message : String(e) });
		}
	}

	return { dates: dates.length, succeeded, failed, totalSlots, inserted, updated, reconciledDeleted, errors };
}
