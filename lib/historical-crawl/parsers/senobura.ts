import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow, OAChannelSlug } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";

// shop.asahi.co.jp shares one template for SENOBURA and URANADJA.
export function parseAsahiCategory(
	html: string,
	jstDate: string,
	channel: OAChannelSlug,
	url: string,
	sourceSheet: string,
): HistoricalRow[] {
	const $ = cheerio.load(html);
	const dow = dayOfWeekJp(jstDate);
	const rows: HistoricalRow[] = [];

	$("h3.item-list-name-box").each((_, el) => {
		const h3 = $(el);
		const link = h3.find("a[href]").first();
		const href = link.attr("href") ?? "";
		const name =
			(link.attr("title") ?? "").trim() || link.text().replace(/\s+/g, " ").trim();
		if (!name || name.length < 3) return;

		// price-area sits as a sibling div following the h3
		const priceArea = h3.nextAll("div.price-area").first();
		const priceText = priceArea.find("p.price").first().text().replace(/\s+/g, " ").trim();
		const { price, incl } = parsePrice(priceText);

		rows.push({
			channel,
			air_date: jstDate,
			day_of_week: dow,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, url).toString() : url,
			source_sheet: sourceSheet,
		});
	});

	return rows;
}

const PAGE_URL = "https://shop.asahi.co.jp/category/SENOBURA/";

export const senoburaParser: ChannelParser = {
	slug: "senobura",
	name: "ABCせのぶら本舗",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		return parseAsahiCategory(r.body, jstDate, "senobura", PAGE_URL, "live-crawl:senobura");
	},
};
