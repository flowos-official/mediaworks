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
ok(rows.length >= 25, `filter page yields products (${rows.length})`);
ok(rows.every((r) => r.air_date === "2026-06-12"), "all rows stamped the filter's date (not jstDate)");
ok(rows.every((r) => r.channel === "kantv"), "channel=kantv");
ok(new Set(rows.map((r) => r.product_name)).size === rows.length, "products deduped within the page");
ok(rows.some((r) => r.price_jpy != null) && rows.some((r) => r.image_url), "prices + images extracted");
ok(rows.some((r) => r.price_is_tax_incl === true), "tax-incl flag read from .c-card__price");

// --- scoping excludes the evergreen promo carousels ---
// The page renders ~30 dated cards plus ~30 evergreen promo cards
// (versatility / recommendation / ranking / 2nd shop_products_section). The
// parser must read ONLY the first exposed-filter results view.
const allCards = (filter4462.match(/class="[^"]*\bc-card\b[^"]*"/g) ?? []).length;
ok(rows.length < allCards, `scoped (${rows.length}) drops evergreen cards (page has ${allCards} c-card nodes)`);
const evergreenSample = "スタイリーフェイス 1台";
ok(!rows.some((r) => r.product_name.startsWith(evergreenSample)), `evergreen product "${evergreenSample}" excluded`);

// --- fallback fingerprint: the homepage's listing equals the latest date's
// (4462) listing. A dead-id filter page also returns this default listing, so
// fetchToday drops any filter page whose fingerprint matches it. ---
const homePrint = __test.listingFingerprint(__test.parseKantv(home, JST_DATE));
const f4462Print = __test.listingFingerprint(rows);
ok(homePrint === f4462Print, "homepage listing fingerprint == latest-date (4462) listing");
ok(homePrint.length > 0, "fingerprint is non-empty");

// --- heading-based capture of the newest date (2026-06-17 fix): because the
// latest date's filter page is indistinguishable from the default by
// fingerprint, the OLD parser dropped it and the newest broadcast went
// uncaptured for ~a week. The homepage labels the default's true date in
// `p.c-foundMenu__current` ("6/12(金)"); we read it and stamp the default
// listing with it instead of dropping. ---
const currentDate = __test.extractCurrentBroadcastDate(home, JST_DATE);
ok(currentDate === "2026-06-12", `reads default listing's broadcast date from p.c-foundMenu__current (${currentDate})`);
const defaultRows = currentDate ? __test.parseKantv(home, currentDate) : [];
ok(defaultRows.length >= 25 && defaultRows.every((r) => r.air_date === "2026-06-12"), `default listing captured under 6/12, not dropped (${defaultRows.length} rows)`);

// --- 3-program OA times (2026-06-19): each program stamps its own start_time;
// omitting it stays null (back-compat). ---
const timed = __test.parseKantv(filter4462, "2026-06-12", "02:20:00");
ok(timed.length > 0 && timed.every((r) => r.start_time === "02:20:00"), "start_time stamped on every row when provided");
ok(rows.every((r) => r.start_time === null), "start_time null when omitted (back-compat)");

// --- weekly 通販スターdaily page labels the broadcast week as
// "MM/DD(月) ～ MM/DD(金)"; the FIRST date is the week-start Monday we stamp on. ---
const weekHtml = '<div class="c-foundMenu__current">06/15(月) ～ 06/19(金)</div>';
ok(__test.extractCurrentBroadcastDate(weekHtml, JST_DATE) === "2026-06-15", "weekly label → week-start Monday (06/15)");

console.log(`\n[test:historical-kantv-parser] ${filters.length} date filters, ${rows.length} dated products on 2026-06-12, ${pass} assertions passed`);
