/** Fixture test for the らくらく茂 / らくらくマート parser.
 *   npx tsx scripts/test-historical-rakuraku-parser.ts
 * Fixture = the real shop.asahi.co.jp/category/RAKURAKU/ page HTML (asahi
 * soft-404s our IPs, so this captured copy is the only local test data; the
 * live path is exercised by the deployed cron from Vercel's IP).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRakuraku } from "../lib/historical-crawl/parsers/rakuraku";
import { dayOfWeekJp } from "../lib/historical-crawl/types";

const html = readFileSync(join(process.cwd(), "scripts/fixtures/historical-crawl/rakuraku-category.html"), "utf-8");
const JST = "2026-06-20";

let pass = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; } else { console.log(`✓ ${msg}`); pass++; }
}

const rows = parseRakuraku(html, JST);

ok(rows.length >= 13, `yields the dated broadcast products (${rows.length})`);
ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.air_date)), "every row has an ISO air_date");
ok(rows.every((r) => r.channel === "rakuraku"), "channel=rakuraku");
ok(rows.every((r) => r.source_sheet === "live-crawl:rakuraku"), "source_sheet=live-crawl:rakuraku");

// the 4 weekly Monday sections on the captured page
const dates = new Set(rows.map((r) => r.air_date));
ok(
	dates.has("2026-06-15") && dates.has("2026-06-08") && dates.has("2026-06-01") && dates.has("2026-05-25"),
	`captures the 4 weekly Monday sections (${[...dates].sort().join(", ")})`,
);

// every air_date must be a Monday (weekly program) — proves week-label parsing
ok(rows.every((r) => dayOfWeekJp(r.air_date) === "月"), "every air_date is a Monday (週放送分 week-start)");
ok(rows.every((r) => r.day_of_week === "月"), "day_of_week stamped 月");
ok(rows.every((r) => r.start_time === null), "start_time null (週放送分 carries no HH:MM)");

// content spot-checks
ok(rows.some((r) => r.product_name.includes("ヒップフィッター") && r.air_date === "2026-06-15"), "ヒップフィッター dated to its 6/15 week");
ok(rows.some((r) => r.price_jpy != null), "prices extracted from .price-area");
ok(rows.every((r) => (r.source_url ?? "").startsWith("https://shop.asahi.co.jp/")), "source_url resolved absolute");

// the おすすめ slider (different markup, future 【7/20～】 items) must NOT leak in
ok(!rows.some((r) => r.air_date > "2026-06-22"), "undated おすすめ-grid items excluded (no far-future dates)");

console.log(`\n[test:historical-rakuraku-parser] ${rows.length} dated products across ${dates.size} Monday weeks, ${pass} assertions passed`);
