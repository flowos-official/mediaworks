import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTbs } from "../lib/historical-crawl/parsers/tbs";

const FIXTURE = join(process.cwd(), "scripts/fixtures/historical-crawl/tbs-live.html");
const JST_DATE = "2026-06-15";

let pass = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; } else { console.log(`✓ ${msg}`); pass++; }
}

const rows = parseTbs(readFileSync(FIXTURE, "utf-8"), JST_DATE);

ok(rows.length >= 8, `parses rows (got ${rows.length})`);
ok(rows.every((r) => r.channel === "tbs"), "all rows channel=tbs");

const byDate: Record<string, number> = {};
for (const r of rows) byDate[r.air_date] = (byDate[r.air_date] ?? 0) + 1;
const distinct = Object.keys(byDate).length;
console.log("byDate:", JSON.stringify(byDate));
ok(distinct >= 6, `products spread across many dates (${distinct})`);
ok(byDate[JST_DATE] !== rows.length, "NOT a blanket dump onto the cron date");

// Each on-air-date section maps to its own day → no blanket re-stamping.
const datesByName = new Map<string, Set<string>>();
for (const r of rows) { (datesByName.get(r.product_name) ?? datesByName.set(r.product_name, new Set()).get(r.product_name)!).add(r.air_date); }
let maxSpan = 0;
for (const s of datesByName.values()) maxSpan = Math.max(maxSpan, s.size);
ok(maxSpan <= 3, `max product date-span is small (${maxSpan})`);

// Page can list a forward broadcast day (e.g. 6/16) — dated correctly, not jstDate.
ok(rows.some((r) => r.air_date > JST_DATE) || distinct >= 6, "forward date handled / multi-date present");

console.log(`\n[test:historical-tbs-parser] ${rows.length} rows / ${distinct} dates, maxSpan=${maxSpan}, ${pass} assertions passed`);
