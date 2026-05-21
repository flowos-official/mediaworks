import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

const PAGE_URL = "https://www.dinos.co.jp/tv/premium/";

function parse(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const dow = dayOfWeekJp(jstDate);
	const rows: HistoricalRow[] = [];

	$("dl.clearfix").each((_, el) => {
		const dl = $(el);
		// Product detail link can be either:
		//   (a) an inner <a href="/p/..."> on the title/image, or
		//   (b) a parent <a href="//www.dinos.co.jp/p/..."> wrapping the whole dl.
		// Most rows on /tv/premium/ today use the wrapper form.
		const innerHref = dl.find("a[href*='/p/']").first().attr("href");
		const parentHref = dl.parent("a[href]").attr("href");
		const href = innerHref ?? parentHref ?? "";
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
			source_url: href ? new URL(href, PAGE_URL).toString() : null,
			source_sheet: "live-crawl:dinos",
			image_url: null,
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
		const rows = parse(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
