import type { ShopchProduct, SlotMeta, SlotParseResult } from "./types";

const BASE = "https://www.shopch.jp";

function priceFromString(raw: unknown): number | null {
	if (raw == null) return null;
	const s = String(raw).trim();
	if (!s) return null;
	const digits = s.replace(/[^0-9]/g, "");
	if (!digits) return null;
	const n = Number(digits);
	return Number.isFinite(n) ? n : null;
}

function offRateFrom(raw: unknown): number | null {
	if (raw == null) return null;
	const s = String(raw).trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

function absUrl(rel: string | null | undefined): string | null {
	if (!rel) return null;
	if (rel.startsWith("http")) return rel;
	if (rel.startsWith("//")) return `https:${rel}`;
	if (rel.startsWith("/")) return `${BASE}${rel}`;
	return `${BASE}/${rel}`;
}

function detailUrl(linkOrId: string | null | undefined, reqPrNo: string): string {
	// The JSON gives `prodNameLinkUrl: "ProdDetailShow.do?reqprno=NNNN&breadcrumb="`.
	if (linkOrId && linkOrId.startsWith("ProdDetail")) {
		return `${BASE}/pc/product/${linkOrId}`;
	}
	return `${BASE}/pc/product/ProdDetailShow.do?reqprno=${reqPrNo}`;
}

/**
 * Parse one Shop Channel slot JSON into structured products + slot metadata.
 *
 * The slot key is taken from `tlcdate` + `tlcsttime` in the JSON itself, so
 * callers can pass the result through without re-deriving.
 */
export function parseSlotJson(raw: unknown): SlotParseResult | null {
	if (!raw || typeof raw !== "object") return null;
	const j = raw as Record<string, unknown>;

	const tlcdate = typeof j.tlcdate === "string" ? j.tlcdate : null;
	const tlcsttime = typeof j.tlcsttime === "string" ? j.tlcsttime : null;
	if (!tlcdate || !tlcsttime || tlcdate.length !== 8 || tlcsttime.length !== 6) {
		return null;
	}

	const slotKey = `${tlcdate}${tlcsttime}`;
	const airDate = `${tlcdate.slice(0, 4)}-${tlcdate.slice(4, 6)}-${tlcdate.slice(6, 8)}`;
	const startTime = `${tlcsttime.slice(0, 2)}:${tlcsttime.slice(2, 4)}:${tlcsttime.slice(4, 6)}`;

	const meta: SlotMeta = {
		slot_key: slotKey,
		air_date: airDate,
		start_time: startTime,
		program_name: typeof j.pgmname === "string" ? j.pgmname : null,
		category: typeof j.pgmcategory === "string" ? j.pgmcategory : null,
		brand: typeof j.brandname === "string" ? j.brandname : null,
		video_path: typeof j.pgmMovie === "string" ? j.pgmMovie : null,
	};

	const rawProds = Array.isArray(j.prodList1) ? j.prodList1 : [];
	const products: ShopchProduct[] = [];
	for (const item of rawProds) {
		if (!item || typeof item !== "object") continue;
		const p = item as Record<string, unknown>;
		const reqPrNo = typeof p.reqPrNo === "string" ? p.reqPrNo.trim() : "";
		if (!/^\d+$/.test(reqPrNo)) continue;

		products.push({
			id: reqPrNo,
			name: typeof p.prodName === "string" ? p.prodName : "",
			brand: meta.brand,
			category: meta.category,
			price_jpy: priceFromString(p.genzaiPrice),
			compare_price_jpy: priceFromString(p.comperPrice),
			off_rate: offRateFrom(p.offRate),
			image_url: absUrl(typeof p.prodImg === "string" ? p.prodImg : null),
			source_url: detailUrl(
				typeof p.prodNameLinkUrl === "string" ? p.prodNameLinkUrl : null,
				reqPrNo,
			),
			slot_key: slotKey,
		});
	}

	return { meta, products };
}

/**
 * Build the slot-JSON URL for a given (airDate, startTime).
 *   air_date = "YYYY-MM-DD", start_time = "HH:MM:SS"
 */
export function slotJsonUrl(airDate: string, startTime: string): string {
	const yyyymmdd = airDate.replace(/-/g, "");
	const hhmmss = startTime.replace(/:/g, "");
	return `${BASE}/json/programprodlist2/${yyyymmdd}${hhmmss}.json`;
}

/**
 * Build the HLS master playlist URL from a slot's `pgmMovie` path or slot key.
 * pgmMovie example: "m3u8/prog/20260513000000/20260513000000"  →
 *   https://www.shopch.jp/m3u8/prog/20260513000000/20260513000000_jwplayer.m3u8
 */
export function slotVideoUrl(slotKey: string, pgmMovie?: string | null): string {
	if (pgmMovie) {
		return `${BASE}/${pgmMovie}_jwplayer.m3u8`;
	}
	return `${BASE}/m3u8/prog/${slotKey}/${slotKey}_jwplayer.m3u8`;
}
