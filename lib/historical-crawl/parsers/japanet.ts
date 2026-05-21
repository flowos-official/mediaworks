import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";

const PAGE_URL =
	"https://www.japanet.co.jp/shopping/internet/BroadMediaGoodsList.do?actType=INIT&listflg=0&baitaicd=T105&pageno=1&headflg=0&accessNo=002";

/**
 * Japanet 「快適ショッピングスタジオ」 (baitaicd=T105) lists today's products
 * as <td class="list_item"> entries containing "[N] 商品名". Page is Shift-JIS,
 * decoded by politeFetch. Prices live on detail pages and are not collected here.
 *
 * source_url is intentionally null: each row's anchor uses JS form-POST
 * navigation (doRefer/doList), so there is no GET-addressable per-product URL.
 * The previous fallback to PAGE_URL was misleading — that listing always shows
 * TODAY's broadcasts, not the row's air_date — so we leave source_url empty
 * and let the UI hide the external-link icon.
 *
 * image_url is derived from the onclick="doRefer(...)" handler attached to
 * each item's anchor. doRefer's 5th–7th positional args (c_skucd, c_color,
 * c_size) compose a product key used in japanet's image CDN as
 * https://img.japanet.co.jp/shopping/simg/{c_skucd}-{c_color}-{c_size}-l.jpg.
 */

/**
 * Parse doRefer('promo','prod','color','size','c_skucd','c_color','c_size',...)
 * Returns null when the onclick attribute doesn't contain a parseable doRefer
 * call (e.g., different navigation function, missing args). Pure function.
 */
export function parseDoReferImageKey(
	onclick: string | null | undefined,
): { c_skucd: string; c_color: string; c_size: string } | null {
	if (!onclick) return null;
	// Positional args 5/6/7 of doRefer (0-indexed: 4, 5, 6). Spaces are common
	// in color/size fields; we trim downstream.
	const m = onclick.match(
		/doRefer\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/,
	);
	if (!m) return null;
	const c_skucd = m[1].trim();
	const c_color = m[2].trim();
	const c_size = m[3].trim();
	if (!c_skucd || !c_color || !c_size) return null;
	return { c_skucd, c_color, c_size };
}

function buildJapanetImageUrl(key: { c_skucd: string; c_color: string; c_size: string }): string {
	return `https://img.japanet.co.jp/shopping/simg/${key.c_skucd}-${key.c_color}-${key.c_size}-l.jpg`;
}

function parseJapanet(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const dow = dayOfWeekJp(jstDate);
	const rows: HistoricalRow[] = [];

	$("td.list_item").each((_, el) => {
		const raw = $(el).text().replace(/\s+/g, " ").trim();
		if (!raw) return;
		const m = raw.match(/^\[(\d+)\]\s*(.+)$/);
		const name = m ? "[" + m[1] + "] " + m[2].trim() : raw;
		if (!name || name.length < 3) return;

		// Image URL: derive from the anchor's doRefer() onclick handler.
		const onclick = $(el).find("a[onclick]").first().attr("onclick");
		const key = parseDoReferImageKey(onclick);
		const image_url = key ? buildJapanetImageUrl(key) : null;

		rows.push({
			channel: "japanet",
			air_date: jstDate,
			day_of_week: dow,
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: null,
			price_jpy: null,
			price_is_tax_incl: null,
			source_url: null,
			source_sheet: "live-crawl:japanet",
			image_url,
		});
	});

	return rows;
}

export const japanetParser: ChannelParser = {
	slug: "japanet",
	name: "ジャパネット",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		return parseJapanet(r.body, jstDate);
	},
};
