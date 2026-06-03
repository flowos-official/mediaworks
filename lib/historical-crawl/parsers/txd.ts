import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";

const API_URL =
	"https://api.tv-tokyoshop.jp/api/v1/product/SearchWithBroadcastDate";
const X_USER_KEY = "ers_v8";
const PAGE_LIMIT = 50;
const MAX_PAGES = 5; // hard cap: 5 pages × 50 = 250 products/day. Defensive.

interface TxdProduct {
	ID: number;
	Gcode: string;
	Gname: string;
	MinPrice: number;
	MaxPrice: number;
	PictureCollection?: { Count: number; URL: string[] } | null;
	IconFlgList?: number[];
	Icon2OffValue?: string;
	SoldoutFlg?: unknown;
	ProgramBroadcastDate?: string | null;
}

export interface TxdApiResponse {
	RSuccess: boolean;
	RMessage?: string;
	RCount?: number;
	Product?: TxdProduct[];
	Pager?: { MaxPage?: number; PageOffset?: number; FromCnt?: number; ToCnt?: number };
}

/**
 * Convert a single API product into a HistoricalRow.
 * Pure function — no I/O. The fixture-based test exercises this directly.
 */
export function txdProductToRow(p: TxdProduct, jstDate: string): HistoricalRow {
	const detailUrl = `https://www.tv-tokyoshop.jp/detail?Gcode=${encodeURIComponent(p.Gcode)}`;
	const min = Number.isFinite(p.MinPrice) ? Math.round(p.MinPrice) : null;
	const max = Number.isFinite(p.MaxPrice) ? Math.round(p.MaxPrice) : null;
	let priceText: string | null = null;
	if (min !== null && max !== null) {
		priceText = min === max ? `¥${min.toLocaleString("ja-JP")}` : `¥${min.toLocaleString("ja-JP")}〜¥${max.toLocaleString("ja-JP")}`;
	}

	return {
		channel: "txd",
		air_date: jstDate,
		day_of_week: dayOfWeekJp(jstDate),
		start_time: null,
		product_name: (p.Gname ?? "").slice(0, 500),
		price_text: priceText ? priceText.slice(0, 200) : null,
		price_jpy: min,
		// Japanese retail prices are displayed tax-inclusive by default
		// (景品表示法 / 総額表示義務, effective 2021). Detail page confirms.
		price_is_tax_incl: min !== null ? true : null,
		source_url: detailUrl,
		source_sheet: "live-crawl:txd",
		image_url: p.PictureCollection?.URL?.[0] ?? null,
	};
}

/**
 * Parse a single API page response into HistoricalRows. Pure function.
 * Skips products with empty/short names defensively.
 */
export function parseTxdResponse(
	response: TxdApiResponse,
	jstDate: string,
): HistoricalRow[] {
	if (!response.RSuccess) return [];
	const products = response.Product ?? [];
	const rows: HistoricalRow[] = [];
	for (const p of products) {
		if (!p?.Gname || p.Gname.trim().length < 3) continue;
		rows.push(txdProductToRow(p, jstDate));
	}
	return rows;
}

function buildUrl(jstDate: string, pageOffset: number): string {
	const broadcastDate = jstDate.replaceAll("-", "/"); // YYYY-MM-DD → YYYY/MM/DD
	const qs = new URLSearchParams({
		BroadcastDate: broadcastDate,
		PageOffset: String(pageOffset),
		PageDispLimit: String(PAGE_LIMIT),
		ProductSearchSort: "1",
		device_pc_flg: "1",
		device_sp_flg: "0",
		device_ap_flg: "0",
	});
	return `${API_URL}?${qs.toString()}`;
}

async function fetchPage(jstDate: string, pageOffset: number): Promise<TxdApiResponse | null> {
	const r = await politeFetch(buildUrl(jstDate, pageOffset), {
		headers: {
			Accept: "application/json, text/plain, */*",
			"X-User-Key": X_USER_KEY,
		},
	});
	if (!r.ok || !r.body) return null;
	try {
		return JSON.parse(r.body) as TxdApiResponse;
	} catch {
		return null;
	}
}

export const txdParser: ChannelParser = {
	slug: "txd",
	name: "テレ東マート",
	fetchToday: async (jstDate) => {
		const first = await fetchPage(jstDate, 1);
		// Distinguish a fetch/parse failure (null) — surfaced as ok:false on the
		// crawl dashboard — from a successful call that genuinely has no data.
		if (!first) throw new Error("fetch/parse failed (page 1)");
		if (!first.RSuccess) return [];
		const rows = parseTxdResponse(first, jstDate);
		const totalCount = first.RCount ?? rows.length;
		// Paginate only if first page didn't already cover everything.
		for (let page = 2; page <= MAX_PAGES && rows.length < totalCount; page++) {
			const next = await fetchPage(jstDate, page);
			if (!next || !next.RSuccess) break;
			const more = parseTxdResponse(next, jstDate);
			if (more.length === 0) break;
			rows.push(...more);
		}
		return rows;
	},
};
