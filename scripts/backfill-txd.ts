/**
 * One-shot backfill of tv-tokyoshop (txd) historical broadcasts.
 *
 * The upstream API exposes ~5 years of schedule data via the
 * `BroadcastDateForCalendar` field. This script:
 *   1. Probes once to enumerate all available dates.
 *   2. Iterates each date (oldest → newest), fetching products.
 *   3. Persists in batches (idempotent — UNIQUE(channel,air_date,product_name)).
 *   4. Throttles between requests to stay polite.
 *
 * Safe to re-run. Existing rows are upserted in place; missing rows fill in.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-txd.ts            # full backfill
 *   npx tsx --env-file=.env.local scripts/backfill-txd.ts --since=2025-01-01
 */

import { txdParser } from "../lib/historical-crawl/parsers/txd";
import { persistRows } from "../lib/historical-crawl/persist";
import type { HistoricalRow } from "../lib/historical-crawl/types";

const THROTTLE_MS = 350;
const BATCH_DATES = 50;
const PROBE_URL =
	"https://api.tv-tokyoshop.jp/api/v1/product/SearchWithBroadcastDate?BroadcastDate=2026/05/21&PageOffset=1&PageDispLimit=5&ProductSearchSort=1&device_pc_flg=1&device_sp_flg=0&device_ap_flg=0";

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function jpDateStringToIso(s: string): string | null {
	// "Thu May 21 00:00:00 UTC+0900 2026" → "2026-05-21"
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return null;
	// Convert to JST calendar date
	const jst = new Date(d.getTime() + 9 * 3600 * 1000);
	return jst.toISOString().slice(0, 10);
}

async function fetchCalendar(): Promise<string[]> {
	const res = await fetch(PROBE_URL, {
		headers: {
			"User-Agent": "MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)",
			Accept: "application/json, text/plain, */*",
			"X-User-Key": "ers_v8",
		},
	});
	if (!res.ok) throw new Error(`probe failed: HTTP ${res.status}`);
	const body = (await res.json()) as { BroadcastDateForCalendar?: string[] };
	const raw = body.BroadcastDateForCalendar ?? [];
	const iso = raw
		.map(jpDateStringToIso)
		.filter((x): x is string => x !== null);
	// Sort ascending (oldest first) — natural insertion order is newest-first.
	iso.sort();
	return iso;
}

(async () => {
	const args = process.argv.slice(2);
	const sinceArg = args.find((a) => a.startsWith("--since="));
	const since = sinceArg?.split("=")[1];

	console.log("Probing calendar ...");
	let dates = await fetchCalendar();
	console.log(`API exposes ${dates.length} dates total.`);

	if (since) {
		const before = dates.length;
		dates = dates.filter((d) => d >= since);
		console.log(`Filtered to ${dates.length} dates (>= ${since}; dropped ${before - dates.length}).`);
	}

	if (dates.length === 0) {
		console.error("No dates to backfill.");
		process.exit(1);
	}

	console.log(`Backfilling ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} dates).`);
	console.log(`Throttle: ${THROTTLE_MS}ms per date, batch persist every ${BATCH_DATES} dates.`);
	console.log();

	const startedAt = Date.now();
	let totalFetched = 0;
	let totalUpserted = 0;
	let totalSkipped = 0;
	let datesWithRows = 0;
	let datesEmpty = 0;
	const errors: Array<{ date: string; error: string }> = [];
	let buffer: HistoricalRow[] = [];

	async function flush() {
		if (buffer.length === 0) return;
		const outcome = await persistRows(buffer);
		totalUpserted += outcome.upserted;
		totalSkipped += outcome.skippedDuplicate;
		buffer = [];
	}

	for (let i = 0; i < dates.length; i++) {
		const d = dates[i];
		try {
			const rows = await txdParser.fetchToday(d);
			totalFetched += rows.length;
			if (rows.length > 0) {
				datesWithRows++;
				buffer.push(...rows);
			} else {
				datesEmpty++;
			}
		} catch (e) {
			errors.push({ date: d, error: e instanceof Error ? e.message : String(e) });
		}

		// Progress every 25 dates
		if ((i + 1) % 25 === 0 || i === dates.length - 1) {
			const pct = ((i + 1) / dates.length * 100).toFixed(1);
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
			console.log(
				`[${i + 1}/${dates.length} ${pct}%]  date=${d}  fetched=${totalFetched}  errors=${errors.length}  elapsed=${elapsed}s`,
			);
		}

		// Batch persist
		if ((i + 1) % BATCH_DATES === 0) {
			await flush();
		}

		if (i < dates.length - 1) await sleep(THROTTLE_MS);
	}

	await flush();

	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
	console.log();
	console.log("=== Summary ===");
	console.log(`dates processed:   ${dates.length}`);
	console.log(`dates with rows:   ${datesWithRows}`);
	console.log(`dates empty:       ${datesEmpty}`);
	console.log(`rows fetched:      ${totalFetched}`);
	console.log(`rows upserted:     ${totalUpserted}`);
	console.log(`rows skipped dup:  ${totalSkipped}`);
	console.log(`errors:            ${errors.length}`);
	console.log(`elapsed:           ${elapsed}s`);

	if (errors.length > 0) {
		console.log();
		console.log("First 10 errors:");
		for (const e of errors.slice(0, 10)) {
			console.log(`  ${e.date}: ${e.error}`);
		}
	}
})();
