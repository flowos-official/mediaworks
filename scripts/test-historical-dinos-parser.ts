import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDinos } from "../lib/historical-crawl/parsers/dinos";

const FIXTURE = join(process.cwd(), "scripts/fixtures/historical-crawl/dinos-schedule.html");
const JST_DATE = "2026-06-15";

let pass = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; } else { console.log(`✓ ${msg}`); pass++; }
}

const rows = parseDinos(readFileSync(FIXTURE, "utf-8"), JST_DATE);

ok(rows.length >= 10, `parses month schedule rows (got ${rows.length})`);
ok(rows.every((r) => r.channel === "dinos"), "all rows channel=dinos");

const byDate: Record<string, number> = {};
for (const r of rows) byDate[r.air_date] = (byDate[r.air_date] ?? 0) + 1;
const distinct = Object.keys(byDate).length;
console.log("byDate:", JSON.stringify(byDate));
ok(distinct >= 10, `one entry per broadcast day (${distinct} dates)`);

// Each broadcast day has its own product → no blanket re-stamping.
const datesByName = new Map<string, Set<string>>();
for (const r of rows) { (datesByName.get(r.product_name) ?? datesByName.set(r.product_name, new Set()).get(r.product_name)!).add(r.air_date); }
let maxSpan = 0;
for (const s of datesByName.values()) maxSpan = Math.max(maxSpan, s.size);
ok(maxSpan <= 2, `max product date-span is small (${maxSpan})`);

// Date comes from the entry's image alt, not jstDate (forward dates appear).
ok(rows.some((r) => r.air_date > JST_DATE), "forward broadcast days present (dated from alt, not jstDate)");
ok(rows.every((r) => r.image_url), "image extracted for every entry");
ok(rows.some((r) => r.product_name.includes("クリアージュ") && r.air_date === "2026-06-01"), "クリアージュ アイリフトNeo dated 2026-06-01");

console.log(`\n[test:historical-dinos-parser] ${rows.length} rows / ${distinct} dates, maxSpan=${maxSpan}, ${pass} assertions passed`);
