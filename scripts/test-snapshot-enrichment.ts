import {
	buildQvcSnapshotRows,
	buildShopChSnapshotRows,
	pickBrandFromQvcProducts,
} from "../lib/broadcasts/snapshot-enrichment";
import type { ShopChProductSnapshot } from "../lib/broadcasts/shopch-json";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else { console.log(`✓ ${msg}`); }
}

// ---- QVC ----
const qvcSlot = {
	id: "bcast-1",
	channel: "qvc" as const,
	product_ids: ["100", "200", "300"],
};
const qvcProducts = [
	{ id: "100", name: "プロダクト 100", image_url: "https://x/100.jpg", price_text: "¥12,000", brand: null,           original_price_jpy: null, sale_label: null },
	{ id: "200", name: "プロダクト 200", image_url: "https://x/200.jpg", price_text: "¥3,980",  brand: "ブランドB",     original_price_jpy: 5980, sale_label: "WSV" },
];
const qvcRows = buildQvcSnapshotRows(qvcSlot.id, qvcSlot.product_ids, qvcProducts);
assert(qvcRows.length === 2, "QVC: 2 rows produced (missing id 300 skipped)");
assert(qvcRows[0].position === 0 && qvcRows[0].product_id === "100", "QVC: position 0 = first id");
assert(qvcRows[1].price_jpy === 3980, "QVC: price_jpy parsed from price_text");
assert(qvcRows[1].original_price_jpy === 5980, "QVC: original_price_jpy passed through");
assert(qvcRows[1].discount_rate === 33, "QVC: discount_rate computed (5980→3980 = 33%)");
assert(qvcRows[0].source === "qvc", "QVC: source label");
const qvcBrand = pickBrandFromQvcProducts(qvcSlot.product_ids, qvcProducts);
assert(qvcBrand === "ブランドB", "QVC: brand picked from first non-null");

// ---- QVC price_text that carries more than one number ----
// A detail page whose inline price block holds both the sale and the list
// price used to have every digit concatenated into one impossible value
// ("¥38,200 ¥53,700" → 382000537000), overflowing the int4 column and
// dropping the whole slot's snapshot rows.
const messyPriceProducts = [
	{ id: "400", name: "二重価格", image_url: null, price_text: "¥38,200 ¥53,700", brand: null, original_price_jpy: null, sale_label: null },
	{ id: "401", name: "税込表記", image_url: null, price_text: "1,280円(税込 1,408円)", brand: null, original_price_jpy: null, sale_label: null },
	{ id: "402", name: "小数点", image_url: null, price_text: "JPY 38200.00", brand: null, original_price_jpy: null, sale_label: null },
	{ id: "403", name: "非現実価格", image_url: null, price_text: "¥2,300,030,000", brand: null, original_price_jpy: null, sale_label: null },
	{ id: "404", name: "価格なし", image_url: null, price_text: "価格はカートで", brand: null, original_price_jpy: null, sale_label: null },
	{ id: "405", name: "定価も異常", image_url: null, price_text: "¥3,980", brand: null, original_price_jpy: 2300030000, sale_label: null },
];
const messyRows = buildQvcSnapshotRows("bcast-2", ["400", "401", "402", "403", "404", "405"], messyPriceProducts);
assert(messyRows[0].price_jpy === 38200, "QVC: two prices in one string → first one wins");
assert(messyRows[1].price_jpy === 1280, "QVC: tax-inclusive suffix ignored");
assert(messyRows[2].price_jpy === 38200, "QVC: decimal part dropped");
assert(messyRows[3].price_jpy === null, "QVC: implausible price rejected instead of overflowing int4");
assert(messyRows[4].price_jpy === null, "QVC: no digits → null");
assert(messyRows[5].original_price_jpy === null, "QVC: implausible original_price_jpy rejected too");
assert(messyRows[5].discount_rate === null, "QVC: discount_rate not computed from a rejected list price");

// ---- ShopCh ----
const shopchProducts: ShopChProductSnapshot[] = [
	{
		productId: "555",
		name: "ショップCH商品",
		imageUrl: "https://x/555.jpg",
		priceJpy: 7700,
		originalPriceJpy: 18700,
		discountRate: 58,
		saleLabel: "期間限定",
		taxIncl: true,
		inStockAtCapture: true,
	},
];
const shopchRows = buildShopChSnapshotRows("bcast-2", shopchProducts);
assert(shopchRows.length === 1, "ShopCh: 1 row");
assert(shopchRows[0].discount_rate === 58, "ShopCh: discount_rate from JSON offRate");
assert(shopchRows[0].in_stock_at_capture === true, "ShopCh: in_stock_at_capture");
assert(shopchRows[0].source === "shopch", "ShopCh: source label");

// ---- parseDurationFromStderr ----
import { parseDurationFromStderr } from "../lib/broadcasts/video-archival";

assert(parseDurationFromStderr("Duration: 01:23:45.00, start: 0") === 5025, "parseDuration: 1h23m45s = 5025s");
assert(parseDurationFromStderr("nothing here") === null, "parseDuration: null when absent");
