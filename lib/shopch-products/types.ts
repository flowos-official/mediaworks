/**
 * Shop Channel slot-JSON product representation. Sourced from:
 *   /json/programprodlist2/{YYYYMMDDHHMMSS}.json
 * Each slot lists the products covered by that broadcast slot in `prodList1`
 * (primary lineup). Some slots also carry `prodList2` (secondary), but the
 * primary list is what actually airs.
 */
export interface ShopchProduct {
	id: string; // reqPrNo (e.g. "819208")
	name: string;
	brand: string | null;
	category: string | null;
	price_jpy: number | null;
	compare_price_jpy: number | null;
	off_rate: number | null;
	image_url: string | null;
	source_url: string;
	slot_key: string; // YYYYMMDDHHMMSS
}

export interface SlotMeta {
	slot_key: string;
	air_date: string; // YYYY-MM-DD
	start_time: string; // HH:MM:SS
	program_name: string | null;
	category: string | null;
	brand: string | null;
	video_path: string | null; // relative, e.g. "m3u8/prog/20260513000000/20260513000000"
}

export interface SlotParseResult {
	meta: SlotMeta;
	products: ShopchProduct[];
}
