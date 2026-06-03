import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

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
		const { price, incl } = parsePrice(desc);
		// Only persist price_text when parsePrice actually extracted a JPY value.
		// The card description otherwise contains a marketing blurb (no yen
		// figure), which would render as a fake price in the UI's price column.
		const priceText = price != null ? desc : null;
		const href = link.attr("href") ?? "";
		rows.push({
			channel: "junsanpo",
			air_date: jstDate,
			day_of_week: dow,
			start_time: null,
			product_name: title.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:junsanpo",
			image_url: null,
		});
	});

	return rows;
}

export const junsanpoParser: ChannelParser = {
	slug: "junsanpo",
	name: "テレ朝じゅん散歩",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		const rows = parse(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
