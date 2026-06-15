import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJunsanpo } from "../lib/historical-crawl/parsers/junsanpo";

const FIXTURE = join(process.cwd(), "scripts/fixtures/historical-crawl/junsanpo-live.html");
const JST_DATE = "2026-06-15"; // fixture captured this day; balloons span ~3 weeks back

let pass = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; } else { console.log(`✓ ${msg}`); pass++; }
}

const rows = parseJunsanpo(readFileSync(FIXTURE, "utf-8"), JST_DATE);

ok(rows.length >= 100, `parses many rows (got ${rows.length})`);
ok(rows.every((r) => r.channel === "junsanpo"), "all rows channel=junsanpo");

// Dates must come from balloon headers, spread across the ~3-week window —
// NOT all blanket-stamped onto the cron date.
const byDate: Record<string, number> = {};
for (const r of rows) byDate[r.air_date] = (byDate[r.air_date] ?? 0) + 1;
const distinct = Object.keys(byDate).length;
console.log("byDate:", JSON.stringify(byDate));
ok(distinct >= 8, `products spread across many dates (${distinct})`);
ok(byDate[JST_DATE] !== rows.length, "NOT a blanket dump onto the cron date");

// Blanket signature gone: no single product spread across an implausible
// number of distinct dates (raw blanket data had maxSpan ~14).
const datesByName = new Map<string, Set<string>>();
for (const r of rows) { (datesByName.get(r.product_name) ?? datesByName.set(r.product_name, new Set()).get(r.product_name)!).add(r.air_date); }
let maxSpan = 0;
for (const s of datesByName.values()) maxSpan = Math.max(maxSpan, s.size);
ok(maxSpan <= 5, `max product date-span is small (${maxSpan})`);

// Every date is a valid ISO within a sane window.
ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.air_date) && r.air_date <= JST_DATE), "all air_dates ISO and <= ref date");

console.log(`\n[test:historical-junsanpo-parser] ${rows.length} rows / ${distinct} dates, maxSpan=${maxSpan}, ${pass} assertions passed`);
