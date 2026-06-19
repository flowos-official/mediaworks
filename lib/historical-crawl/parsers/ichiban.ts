import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { parseSlashMonthDay } from "../section-date";

// いちばん本舗 (東海テレビ — shop.tokai-tv.com). Added 2026-06-19 per operator
// feedback. The "最近紹介した商品一覧" page (/shop/found/list.aspx) groups
// recently-aired products under dated section headers `h3.block-found--title`
// ("06/19(金)放送"), one per broadcast day, with that day's products
// (`.block-found-f--goods`) following in document order.
//
// Walk headers + cards in document order and stamp each card with its section's
// date — never the cron's jstDate (the per-section dating discipline tbs/ntv/
// junsanpo use). NB: the top-of-page anchor nav also renders date <a> links; we
// only treat `h3.block-found--title` as a header so the nav is ignored. The
// page omits the year, so section-date.ts resolves it nearest the cron date.
// Idempotent upsert on UNIQUE(channel, air_date, product_name) self-heals reruns.
const PAGE_URL = "https://shop.tokai-tv.com/shop/found/list.aspx";

export function parseIchiban(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	let currentDate: string | null = null;

	$("h3.block-found--title, .block-found-f--goods").each((_, el) => {
		const e = $(el);

		if (e.is("h3.block-found--title")) {
			const d = parseSlashMonthDay(e.text(), jstDate);
			if (d) currentDate = d;
			return;
		}

		// .block-found-f--goods — skip cards before the first dated header.
		if (!currentDate) return;
		const airDate = currentDate;

		const link = e.find('a[href*="/shop/g/"]').first();
		const name = (link.attr("title") ?? "").trim() || link.text().replace(/\s+/g, " ").trim();
		if (!name || name.length < 3) return;

		const href = link.attr("href") ?? "";
		const priceText = e.find(".block-thumbnail-t--price").first().text().replace(/\s+/g, " ").trim();
		const { price, incl } = parsePrice(priceText);
		const img = e.find(".block-thumbnail-t--goods-image img").first();
		const imgSrc = (img.attr("src") || img.attr("data-src")) ?? "";

		rows.push({
			channel: "ichiban",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:ichiban",
			image_url: imgSrc ? new URL(imgSrc, PAGE_URL).toString() : null,
		});
	});

	return rows;
}

export const ichibanParser: ChannelParser = {
	slug: "ichiban",
	name: "いちばん本舗",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		return parseIchiban(r.body, jstDate);
	},
};
