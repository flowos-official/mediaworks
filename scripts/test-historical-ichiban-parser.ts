/** DB-free unit test for the ichiban (いちばん本舗 / 東海テレビ) parser.
 *   npx tsx scripts/test-historical-ichiban-parser.ts
 * Inline fixture mirrors shop.tokai-tv.com/shop/found/list.aspx: a top anchor
 * nav with date <a> links (must be IGNORED), then h3.block-found--title section
 * headers ("MM/DD(曜)放送") each followed by .block-found-f--goods cards.
 */
import { parseIchiban } from "../lib/historical-crawl/parsers/ichiban";

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
	if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`  ok: ${msg}`);
	else { console.error(`  FAIL: ${msg}\n    expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`); failures++; }
}
function ok(cond: boolean, msg: string) {
	if (cond) console.log(`  ok: ${msg}`);
	else { console.error(`  FAIL: ${msg}`); failures++; }
}

const goods = (id: string, name: string, price: string) => `
	<dl class="block-found-f--goods">
		<dt class="block-thumbnail-t--goods-image block-goods-list--image-relative">
			<a href="/shop/g/g${id}/" title="${name}" class="js-enhanced-ecommerce-image">
				<figure><img alt="${name}" src="/img/goods/S/${id}.jpg" loading="lazy"></figure>
			</a>
		</dt>
		<dd class="block-thumbnail-t--goods-description">
			<div class="block-thumbnail-t--price-infos">
				<div class="block-thumbnail-t--price price js-enhanced-ecommerce-goods-price">${price}</div>
			</div>
			<div class="block-thumbnail-t--goods-name"><a href="/shop/g/g${id}/" title="${name}" class="js-enhanced-ecommerce-goods-name">${name}</a></div>
		</dd>
	</dl>`;

const HTML = `
<div class="block-found-head-anker">
	<ul class="block-found-anker-list">
		<li><a href="#onair_dt0">06/19(金)</a></li>
		<li><a href="#onair_dt1">06/18(木)</a></li>
	</ul>
</div>
<div class="block-found-f-items">
	${goods("999-0", "ヘッダ前STRAY商品", "1,000")}
	<h3 class="block-found--title">06/19(金)放送</h3>
	<div class="block-found-f--goods-wrap">
		${goods("111-0", "皮膚感覚ひざサポーター aruko 両足用2枚組", "6,980")}
		${goods("222-0", "横向き寝専用枕 YOKONEGU カバー付きセット", "12,800")}
	</div>
	<h3 class="block-found--title">06/18(木)放送</h3>
	<div class="block-found-f--goods-wrap">
		${goods("333-0", "ダクトレス スポットクーラー", "3,300")}
	</div>
</div>`;

function main() {
	const rows = parseIchiban(HTML, "2026-06-19");

	eq(rows.length, 3, "3 dated rows (the card before the first header is skipped)");
	eq(rows.map((r) => r.air_date), ["2026-06-19", "2026-06-19", "2026-06-18"], "section dates assigned in document order");
	ok(rows.every((r) => !r.product_name.includes("STRAY")), "card before any date header is skipped (no jstDate fallback)");
	eq(rows[0].product_name, "皮膚感覚ひざサポーター aruko 両足用2枚組", "name from anchor title attr");
	eq(rows[0].price_jpy, 6980, "price parsed from .block-thumbnail-t--price");
	eq(rows[1].price_jpy, 12800, "second price parsed");
	eq(rows[0].channel, "ichiban", "channel slug");
	eq(rows[0].source_sheet, "live-crawl:ichiban", "source_sheet tag");
	eq(rows[0].day_of_week, "金", "day_of_week computed from air_date");
	eq(rows[2].air_date, "2026-06-18", "third row belongs to the second section");
	ok(rows[0].source_url === "https://shop.tokai-tv.com/shop/g/g111-0/", "source_url resolved absolute");
	ok(rows[0].image_url === "https://shop.tokai-tv.com/img/goods/S/111-0.jpg", "image_url resolved absolute from card thumbnail");
	ok(rows.every((r) => r.start_time === null), "start_time null (page exposes no per-slot HH:MM)");

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}
main();
