import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";

const PAGE_URL = "https://www.dinos.co.jp/tv/premium/";

function parse(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const dow = dayOfWeekJp(jstDate);
	const rows: HistoricalRow[] = [];

	$("dl.clearfix").each((_, el) => {
		const dl = $(el);
		// product detail anchor lives in dt; the product title appears in cms_datatitle dt or via img alt
		const link = dl.find("a[href*='/p/']").first();
		const href = link.attr("href") ?? "";
		const titleText = dl.find("div.cms_datatitle").first().text().replace(/\s+/g, " ").trim();
		const imgAlt = dl.find("img[alt]").first().attr("alt") ?? "";
		const name = titleText || imgAlt.trim();
		if (!name || name.length < 3) return;

		const priceText = dl
			.find("div.saleprice, .saleprice")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		const { price, incl } = parsePrice(priceText);

		rows.push({
			channel: "dinos",
			air_date: jstDate,
			day_of_week: dow,
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:dinos",
		});
	});

	return rows;
}

export const dinosParser: ChannelParser = {
	slug: "dinos",
	name: "フジDinos",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		return parse(r.body, jstDate);
	},
};
