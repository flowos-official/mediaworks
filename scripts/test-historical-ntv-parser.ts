import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNtv, resolveHeaderDate } from "../lib/historical-crawl/parsers/ntv";

const FIXTURE = join(process.cwd(), "scripts/fixtures/historical-crawl/ntv-live.html");
// Fixture captured 2026-06-15; page listed sections for 6/11..6/15.
const JST_DATE = "2026-06-15";

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

function main() {
	// --- resolveHeaderDate unit checks (Dec/Jan rollover) ---
	assert(resolveHeaderDate(6, 11, "2026-06-15") === "2026-06-11", "M/D resolves within same month");
	assert(resolveHeaderDate(1, 2, "2025-12-31") === "2026-01-02", "Dec ref → Jan rolls to next year");
	assert(resolveHeaderDate(12, 30, "2026-01-02") === "2025-12-30", "Jan ref → Dec rolls to prev year");

	const html = readFileSync(FIXTURE, "utf-8");
	const rows = parseNtv(html, JST_DATE);

	assert(rows.length >= 1, `parser returns rows (got ${rows.length})`);
	assert(rows.every((r) => r.channel === "ntv"), "all rows channel=ntv");

	// Every air_date must come from a real section header (6/11..6/15), never
	// the undated carousel — and never the cron date as a blanket stamp.
	const dates = new Set(rows.map((r) => r.air_date));
	const allowed = new Set(["2026-06-11", "2026-06-12", "2026-06-14", "2026-06-15"]);
	for (const d of dates) {
		assert(allowed.has(d), `air_date ${d} is a parsed section date`);
	}

	// THE regression: the user's product aired 昼6/11 must be dated 2026-06-11,
	// and crucially NOT blanket-stamped to the cron run date (2026-06-15) the way
	// the old parser did.
	const beaute = rows.filter((r) => r.product_name.includes("コードレスブラシアイロン"));
	assert(beaute.length >= 1, "my Beaute コードレスブラシアイロン is present");
	assert(
		beaute.some((r) => r.air_date === "2026-06-11"),
		`my Beaute stamped 2026-06-11 (got ${beaute.map((r) => r.air_date).join(",")})`,
	);

	// Leading undated 通販王決定戦 / 三ツ星モール carousel (11 cards) must be
	// excluded: the fixture has 90 block-items, 79 of which sit under a dated
	// header. (Note: some carousel product names recur inside dated sections —
	// those are legitimate and counted there, so we assert on the total, which
	// only holds if the 11 leading undated cards were skipped.)
	assert(rows.length === 79, `dated subset = 79 (90 block-items − 11 undated carousel); got ${rows.length}`);

	// Per-date distribution sanity (from the captured fixture).
	const byDate: Record<string, number> = {};
	for (const r of rows) byDate[r.air_date] = (byDate[r.air_date] ?? 0) + 1;
	console.log("\nrows per air_date:", JSON.stringify(byDate));
	assert(byDate["2026-06-11"] === 1, `6/11 has exactly 1 product (got ${byDate["2026-06-11"]})`);
	assert(Object.keys(byDate).length >= 4, "multiple distinct broadcast dates produced");
	assert(byDate["2026-06-15"] < 90, "cron date is not a blanket dump of all products");

	console.log(`\n[test:historical-ntv-parser] ${rows.length} rows parsed across ${Object.keys(byDate).length} dates`);
}

main();
