import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parseSlashMonthDay } from "../section-date";

/**
 * フジDinos (いいものプレミアム). The product grid at /tv/premium only renders
 * the current day's broadcast, so the old parser stamped every card with the
 * cron's jstDate — a product featured for days then appeared on each of them.
 * The monthly schedule page lists one entry per broadcast day with the real
 * date in each item's image alt ("6/1（月）放送　クリアージュ アイリフトNeo")
 * plus a /p/ product link. Parse that instead so every product carries its
 * true air date. (Prices aren't exposed on the schedule page → null; image +
 * name + date are.)
 */
const PAGE_URL = "https://www.dinos.co.jp/tv/premium_schedule_s/";
// "6/1（月）放送　<name>" — full-width or ASCII paren/space; capture the name tail.
const ALT_RE = /\d{1,2}\/\d{1,2}[（(][日月火水木金土][)）]\s*放送[\s　]*(.+)$/;

export function parseDinos(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	const seen = new Set<string>();

	$("a[href*='/p/']").each((_, el) => {
		const a = $(el);
		const img = a.find("img[alt]").first();
		const alt = (img.attr("alt") ?? "").replace(/　/g, " ").replace(/\s+/g, " ").trim();
		const airDate = parseSlashMonthDay(alt, jstDate);
		if (!airDate) return; // non-broadcast links (e.g. social) have no dated alt

		const name = ALT_RE.exec(alt)?.[1]?.trim() ?? "";
		if (!name || name.length < 3) return;

		const key = `${airDate}|${name}`;
		if (seen.has(key)) return;
		seen.add(key);

		const href = a.attr("href") ?? "";
		const imgSrc = img.attr("src") ?? "";

		rows.push({
			channel: "dinos",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: null,
			price_jpy: null,
			price_is_tax_incl: null,
			source_url: href ? new URL(href, PAGE_URL).toString() : null,
			source_sheet: "live-crawl:dinos",
			image_url: imgSrc ? new URL(imgSrc, PAGE_URL).toString() : null,
		});
	});

	return rows;
}

export const dinosParser: ChannelParser = {
	slug: "dinos",
	name: "フジDinos",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		return parseDinos(r.body, jstDate);
	},
};
