/**
 * Shared date helpers for OA channel pages that group products under dated
 * section headers (e.g. ntv "昼6/11放送", junsanpo "6月15日(月)", tbs
 * "6月16日（火）放送"). The page omits the year, so resolve it relative to the
 * cron reference date, picking the year whose date lands closest — this
 * handles Dec/Jan boundary crossings without guesswork.
 */

/** Resolve a year-less month/day to YYYY-MM-DD nearest the reference date. */
export function resolveYearClosest(month: number, day: number, refDate: string): string {
	const [ry, rm, rd] = refDate.split("-").map((x) => parseInt(x, 10));
	const refUTC = Date.UTC(ry, rm - 1, rd);
	const mm = String(month).padStart(2, "0");
	const dd = String(day).padStart(2, "0");
	let best: { iso: string; diff: number } | null = null;
	for (const y of [ry - 1, ry, ry + 1]) {
		const diff = Math.abs(Date.UTC(y, month - 1, day) - refUTC);
		if (!best || diff < best.diff) best = { iso: `${y}-${mm}-${dd}`, diff };
	}
	return best!.iso;
}

/** Parse "M月D日" (optionally with trailing "(曜)") → ISO date, else null. */
export function parseJpMonthDay(text: string, refDate: string): string | null {
	const m = text.normalize("NFKC").match(/(\d{1,2})月(\d{1,2})日/);
	if (!m) return null;
	return resolveYearClosest(parseInt(m[1], 10), parseInt(m[2], 10), refDate);
}

/** Parse "M/D" (optionally with "(曜)") → ISO date, else null. */
export function parseSlashMonthDay(text: string, refDate: string): string | null {
	const m = text.normalize("NFKC").match(/(\d{1,2})\/(\d{1,2})/);
	if (!m) return null;
	return resolveYearClosest(parseInt(m[1], 10), parseInt(m[2], 10), refDate);
}
