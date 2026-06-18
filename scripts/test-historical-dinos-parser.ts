import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDinos, parseDinosProductDetail } from "../lib/historical-crawl/parsers/dinos";

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

// --- product detail enrichment (price + image from /p/ page) ---
// Minimal HTML mirroring the real dinos /p/ markup observed 2026-06-18.
const PRODUCT_HTML = `<!doctype html><html><head>
<meta property="og:image" content="https://www.dinos.co.jp/defaultMall/images/goods/TAA/2606/etc/T61691c1.jpg">
<meta property="product:price:amount" content="5980">
<meta property="og:title" content="猛暑対策ディノス特別セット 通販 - ディノス">
</head><body>
<div class="box-cart-price-01">¥5,980 税込</div>
<div class="price fs-small">¥6,578</div>
</body></html>`;
const detail = parseDinosProductDetail(PRODUCT_HTML, "https://www.dinos.co.jp/p/N000434304/");
ok(detail.price_jpy === 5980, `detail price from product:price:amount (got ${detail.price_jpy})`);
ok(detail.price_is_tax_incl === true, "detail price flagged 税込");
ok(detail.image_url === "https://www.dinos.co.jp/defaultMall/images/goods/TAA/2606/etc/T61691c1.jpg", "detail og:image extracted");

const empty = parseDinosProductDetail("<html><head></head><body>no price here</body></html>", "https://www.dinos.co.jp/p/x/");
ok(empty.price_jpy === null && empty.image_url === null, "detail parse returns nulls when markup absent (non-fatal)");

console.log(`\n[test:historical-dinos-parser] ${rows.length} rows / ${distinct} dates, maxSpan=${maxSpan}, ${pass} assertions passed`);
