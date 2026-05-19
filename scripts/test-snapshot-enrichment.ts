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
