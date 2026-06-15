import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __test } from "../lib/historical-crawl/parsers/kantv";

const DIR = join(process.cwd(), "scripts/fixtures/historical-crawl");
const home = readFileSync(join(DIR, "kantv-home.html"), "utf-8");
const filter4462 = readFileSync(join(DIR, "kantv-filter-4462.html"), "utf-8");
const JST_DATE = "2026-06-15";

let pass = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; } else { console.log(`✓ ${msg}`); pass++; }
}

// --- date↔filter-id extraction from the homepage ---
const filters = __test.extractDateFilters(home, JST_DATE);
ok(filters.length >= 8, `extracts multiple dated filters (${filters.length})`);
ok(filters.every((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.airDate) && /^\d+$/.test(f.id)), "each filter has ISO date + numeric id");
ok(filters.some((f) => f.airDate === "2026-06-12" && f.id === "4462"), "maps 6/12 → filter id 4462");
ok(new Set(filters.map((f) => f.airDate)).size === filters.length, "filter dates are unique");

// --- a filter page parses into that date's products ---
const rows = __test.parseKantv(filter4462, "2026-06-12");
ok(rows.length >= 30, `filter page yields products (${rows.length})`);
ok(rows.every((r) => r.air_date === "2026-06-12"), "all rows stamped the filter's date (not jstDate)");
ok(rows.every((r) => r.channel === "kantv"), "channel=kantv");
ok(new Set(rows.map((r) => r.product_name)).size === rows.length, "products deduped within the page");
ok(rows.some((r) => r.price_jpy != null) && rows.some((r) => r.image_url), "prices + images extracted");

console.log(`\n[test:historical-kantv-parser] ${filters.length} date filters, ${rows.length} products on 2026-06-12, ${pass} assertions passed`);
