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
 */
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
			image_url: null,
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
