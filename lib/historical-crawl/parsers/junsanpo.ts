import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";

const PAGE_URL = "https://ropping.tv-asahi.co.jp/junsanpo/";

function parse(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const dow = dayOfWeekJp(jstDate);
	const rows: HistoricalRow[] = [];

	$("div.c-product-card__inner").each((_, el) => {
		const card = $(el);
		const link = card.find("a.c-product-card__link").first();
		const desc = card.find("p.c-product-card__description").text().replace(/\s+/g, " ").trim();
		const title = card.find(".c-product-card__title, .c-product-card__name").text().trim() || desc;
		if (!title || title.length < 3) return;
		const priceText = desc;
		const { price, incl } = parsePrice(priceText);
		const href = link.attr("href") ?? "";
		rows.push({
			channel: "junsanpo",
			air_date: jstDate,
			day_of_week: dow,
			product_name: title.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:junsanpo",
		});
	});

	return rows;
}

export const junsanpoParser: ChannelParser = {
	slug: "junsanpo",
	name: "テレ朝じゅん散歩",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		return parse(r.body, jstDate);
	},
};
