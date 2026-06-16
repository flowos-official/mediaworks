import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAsahiCategory } from "../lib/historical-crawl/parsers/senobura";

const DIR = join(process.cwd(), "scripts/fixtures/historical-crawl");
const senobura = readFileSync(join(DIR, "senobura-asahi-live.html"), "utf-8");
const uranoura = readFileSync(join(DIR, "uranoura-asahi-live.html"), "utf-8");
const JST_DATE = "2026-06-16";

let pass = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; } else { console.log(`✓ ${msg}`); pass++; }
}

// --- senobura: every item carries a .onair-time, so all rows are dated ---
const seno = parseAsahiCategory(senobura, JST_DATE, "senobura", "https://shop.asahi.co.jp/category/SENOBURA/", "live-crawl:senobura");
ok(seno.length >= 15, `senobura yields dated rows (${seno.length})`);
ok(seno.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.air_date)), "every senobura row has an ISO air_date");
ok(seno.every((r) => r.start_time !== null), "every senobura row has a start_time (from .onair-time)");
ok(seno.every((r) => r.air_date !== JST_DATE || r.start_time !== null), "no senobura row is a bare jstDate fallback");
// dates span multiple days (it's a ~7-day listing, not today-only)
ok(new Set(seno.map((r) => r.air_date)).size >= 2, `senobura spans multiple broadcast days (${new Set(seno.map((r) => r.air_date)).size})`);
// max distinct-dates-per-product is small (no blanket re-stamping)
{
	const byProd = new Map<string, Set<string>>();
	for (const r of seno) { let s = byProd.get(r.product_name); if (!s) byProd.set(r.product_name, (s = new Set())); s.add(r.air_date); }
	const maxSpan = Math.max(...[...byProd.values()].map((s) => s.size));
	ok(maxSpan <= 3, `senobura maxSpan(1 product on N dates) small (${maxSpan})`);
}

// --- uranoura: the category page is a plain product catalog with NO broadcast
// dates (no .onair-time). The parser must emit ZERO rows, never jstDate-stamped
// ones — that was the blanket-dating bug. ---
const ura = parseAsahiCategory(uranoura, JST_DATE, "uranoura", "https://shop.asahi.co.jp/category/URANADJA/", "live-crawl:uranoura");
ok(ura.length === 0, `uranoura yields ZERO rows (no broadcast dates on page) — got ${ura.length}`);

console.log(`\n[test:historical-asahi-parser] senobura ${seno.length} dated rows, uranoura ${ura.length} rows, ${pass} assertions passed`);
