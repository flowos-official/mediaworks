import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

const PAGE_URL = "https://shopping.tbs.co.jp/tbs/shop/tv_top/kininaru";

function parse(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const dow = dayOfWeekJp(jstDate);
	const rows: HistoricalRow[] = [];

	$("div.p-card__body").each((_, el) => {
		const card = $(el);
		const name = card.find(".text--truncate3line").first().text().replace(/\s+/g, " ").trim();
		if (!name || name.length < 3) return;
		const link = card.find("a[href]").first();
		const href = link.attr("href") ?? "";
		const priceText = card.find(".text--original-price").first().text().replace(/\s+/g, " ").trim();
		const { price, incl } = parsePrice(priceText);
		rows.push({
			channel: "tbs",
			air_date: jstDate,
			day_of_week: dow,
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:tbs",
			image_url: null,
		});
	});

	return rows;
}

export const tbsParser: ChannelParser = {
	slug: "tbs",
	name: "TBSキニナル",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		const rows = parse(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
