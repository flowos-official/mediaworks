/**
 * Pure functions that turn a broadcast slot + its product source into
 * `broadcast_products` row objects. No I/O — the cron caller is responsible
 * for fetching qvc_products / ShopCh JSON and for writing the resulting rows
 * to Supabase. Keeping this pure makes it cheap to unit-test the row shape
 * and the discount/brand derivations without spinning up a DB.
 */
import type { ShopChProductSnapshot } from "./shopch-json";

export interface BroadcastProductRow {
	broadcast_id: string;
	product_id: string;
	position: number;
	name: string | null;
	image_url: string | null;
	price_jpy: number | null;
	original_price_jpy: number | null;
	discount_rate: number | null;
	sale_label: string | null;
	tax_incl: boolean | null;
	in_stock_at_capture: boolean | null;
	source: "qvc" | "shopch";
}

export interface QvcProductLike {
	id: string;
	name: string | null;
	image_url: string | null;
	price_text: string | null;
	brand: string | null;
	original_price_jpy: number | null;
	sale_label: string | null;
}

/**
 * Ceiling for a believable JPY price. `broadcast_products.price_jpy` is int4,
 * so a parse artifact above this range aborts the whole slot's upsert — a null
 * price costs one field, a bad one costs every row in that batch.
 */
const MAX_PLAUSIBLE_PRICE_JPY = 10_000_000;

function plausiblePrice(value: number | null): number | null {
	if (value === null || !Number.isFinite(value)) return null;
	return value > 0 && value <= MAX_PLAUSIBLE_PRICE_JPY ? value : null;
}

function parsePriceText(s: string | null): number | null {
	if (!s) return null;
	// Only the first number: a detail page that renders sale and list price in
	// one block ("¥38,200 ¥53,700") would otherwise fuse into 382000537000.
	const match = s.match(/\d[\d,]*/);
	if (!match) return null;
	return plausiblePrice(parseInt(match[0].replace(/,/g, ""), 10));
}

function computeDiscountRate(
	current: number | null,
	original: number | null,
): number | null {
	if (current === null || original === null || original <= 0) return null;
	if (current >= original) return null;
	return Math.round(((original - current) / original) * 100);
}

export function buildQvcSnapshotRows(
	broadcastId: string,
	productIds: readonly string[],
	qvcProducts: readonly QvcProductLike[],
): BroadcastProductRow[] {
	const byId = new Map<string, QvcProductLike>();
	for (const p of qvcProducts) byId.set(p.id, p);
	const rows: BroadcastProductRow[] = [];
	productIds.forEach((id, position) => {
		const p = byId.get(id);
		if (!p) return;
		const priceJpy = parsePriceText(p.price_text);
		const original = plausiblePrice(p.original_price_jpy);
		rows.push({
			broadcast_id: broadcastId,
			product_id: id,
			position,
			name: p.name,
			image_url: p.image_url,
			price_jpy: priceJpy,
			original_price_jpy: original,
			discount_rate: computeDiscountRate(priceJpy, original),
			sale_label: p.sale_label,
			tax_incl: null,
			in_stock_at_capture: null,
			source: "qvc",
		});
	});
	return rows;
}

export function pickBrandFromQvcProducts(
	productIds: readonly string[],
	qvcProducts: readonly QvcProductLike[],
): string | null {
	const byId = new Map<string, QvcProductLike>();
	for (const p of qvcProducts) byId.set(p.id, p);
	for (const id of productIds) {
		const p = byId.get(id);
		if (p && typeof p.brand === "string" && p.brand.length > 0) return p.brand;
	}
	return null;
}

export function buildShopChSnapshotRows(
	broadcastId: string,
	products: readonly ShopChProductSnapshot[],
): BroadcastProductRow[] {
	return products.map((p, position) => ({
		broadcast_id: broadcastId,
		product_id: p.productId,
		position,
		name: p.name,
		image_url: p.imageUrl,
		price_jpy: p.priceJpy,
		original_price_jpy: p.originalPriceJpy,
		discount_rate: p.discountRate,
		sale_label: p.saleLabel,
		tax_incl: p.taxIncl,
		in_stock_at_capture: p.inStockAtCapture,
		source: "shopch",
	}));
}
