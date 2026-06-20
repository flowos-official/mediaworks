import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { resolveYearClosest } from "../section-date";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

// ABCらくらく茂 / らくらくマート (ABC朝日放送 — shop.asahi.co.jp/category/RAKURAKU/,
// on the ABCミッケ storefront). Added 2026-06-19; parser corrected 2026-06-20
// after the first cron run returned 0 rows.
//
// らくらくマート is a WEEKLY program (airs every Monday). Products are grouped
// under section headers `<span class="onair-time">06/15 (月)週放送分</span>`. That
// reuses the asahi `.onair-time` class as SENOBURA but with a DIFFERENT format:
// a week label "MM/DD (月)週放送分" with NO HH:MM time. SENOBURA's
// parseAsahiCategory requires an "HH:MM分放送" time in the .onair-time and so
// skipped every らくらくマート product — that is why the first cron run captured
// 0 rows. Here we parse the week label's MM/DD as the week-start Monday instead
// and leave start_time null.
//
// Each product is an `h3.item-list-name-box` (same as SENOBURA) with its price in
// a sibling `div.price-area p.price`. The おすすめ slider uses different markup
// (not item-list-name-box), so scoping to item-list-name-box AND requiring a
// preceding week `.onair-time` header captures only the dated broadcast products.
//
// VERIFICATION: shop.asahi.co.jp soft-404s non-Vercel IPs, so a live fetch only
// works from the deployed cron. The parser is fixture-tested against the real
// page HTML (scripts/fixtures/historical-crawl/rakuraku-category.html, captured
// via a server-side reader); confirm the first post-deploy cron run captures rows.
const PAGE_URL = "https://shop.asahi.co.jp/category/RAKURAKU/";

export function parseRakuraku(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	const seen = new Set<string>();

	$("h3.item-list-name-box").each((_, el) => {
		const h3 = $(el);
		const link = h3.find("a[href]").first();
		const href = link.attr("href") ?? "";
		const name = (link.attr("title") ?? "").trim() || link.text().replace(/\s+/g, " ").trim();
		if (!name || name.length < 3) return;

		// Find the section's week header — the nearest `.onair-time`
		// ("MM/DD (月)週放送分") that precedes this product in document order.
		let scope = h3.parent();
		let weekText = "";
		for (let level = 0; level < 8 && scope.length; level++) {
			const ot = scope.find(".onair-time").first();
			if (ot.length) {
				const all = scope.find("*");
				const otIdx = all.index(ot[0]);
				const h3Idx = all.index(h3[0]);
				if (otIdx >= 0 && h3Idx >= 0 && otIdx < h3Idx) {
					weekText = ot.text().replace(/\s+/g, " ").trim();
					break;
				}
			}
			scope = scope.parent();
		}

		// "06/15 (月)週放送分" → week-start Monday. Require 放送 + an MM/DD so the
		// おすすめ grid / undated items are skipped, never blanket-stamped.
		const m = weekText.match(/(\d{1,2})\/(\d{1,2})/);
		if (!m || !/放送/.test(weekText)) return;
		const airDate = resolveYearClosest(parseInt(m[1], 10), parseInt(m[2], 10), jstDate);

		const key = `${airDate}|${name}`;
		if (seen.has(key)) return;
		seen.add(key);

		const priceArea = h3.nextAll("div.price-area").first();
		const priceText = priceArea.find("p.price").first().text().replace(/\s+/g, " ").trim();
		const { price, incl } = parsePrice(priceText);

		rows.push({
			channel: "rakuraku",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:rakuraku",
			image_url: null,
		});
	});

	return rows;
}

export const rakurakuParser: ChannelParser = {
	slug: "rakuraku",
	name: "ABCらくらく茂",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		const rows = parseRakuraku(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
