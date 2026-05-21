import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { ntvApiExtractor } from "../image-extractors/ntv-api";
import { mapWithConcurrency } from "../image-extractors/types";

const PAGE_URL = "https://shop.ntv.co.jp/s/tvshopping/";

function parse(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const dow = dayOfWeekJp(jstDate);
	const rows: HistoricalRow[] = [];

	$("div.block-item").each((_, el) => {
		const item = $(el);
		const link = item.find("a[href*='/item/']").first();
		const href = link.attr("href") ?? "";
		const name = item
			.find("p.text-14px, p.sm\\:line-clamp-3")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		if (!name || name.length < 3) return;
		const priceText = item
			.find("[data-js='wrap-price']")
			.first()
			.text()
			.replace(/[\s¥￥&yen;]/g, "")
			.replace(/\(税込\)/, "(税込)")
			.trim();
		const rawPrice = item.find("[data-js='wrap-price']").first().text().replace(/\s+/g, " ").trim();
		const { price, incl } = parsePrice(rawPrice);
		rows.push({
			channel: "ntv",
			air_date: jstDate,
			day_of_week: dow,
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: rawPrice ? rawPrice.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:ntv",
			image_url: null,
		});
	});

	return rows;
}

export const ntvParser: ChannelParser = {
	slug: "ntv",
	name: "日テレポシュレ",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		const rows = parse(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ntvApiExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
