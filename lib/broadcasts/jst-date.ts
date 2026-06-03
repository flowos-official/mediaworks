/**
 * Shared JST date helpers used by broadcast scraping crons and by the cache
 * invalidation logic that follows. Centralised here so that
 * `daily-broadcasts/route.ts` and `qvc-monthly-refresh/route.ts` stop
 * defining the same logic locally.
 */

/**
 * Returns midnight UTC for "yesterday in JST". The returned Date's
 * UTC y/m/d components match the JST calendar day immediately before
 * the JST day of `nowUtc` (or `new Date()` if omitted).
 */
export function getYesterdayJST(nowUtc: Date = new Date()): Date {
	const jstMs = nowUtc.getTime() + 9 * 3600 * 1000;
	const jstNow = new Date(jstMs);
	jstNow.setUTCDate(jstNow.getUTCDate() - 1);
	return new Date(
		Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()),
	);
}

/**
 * Returns "YYYY-MM-DD" for "today in JST". Works on both server and client:
 * Date.now() is a UTC epoch, so shifting by +9h and reading the ISO date gives
 * the JST calendar day regardless of the host's local timezone.
 */
export function getTodayISOJST(nowUtc: Date = new Date()): string {
	return new Date(nowUtc.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Returns "YYYY-MM" for the given Date's UTC year/month. */
export function getJSTYearMonth(d: Date): string {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	return `${y}-${m}`;
}
