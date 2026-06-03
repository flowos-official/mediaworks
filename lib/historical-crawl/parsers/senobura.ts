import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow, OAChannelSlug } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

// shop.asahi.co.jp shares one template for SENOBURA and URANADJA.
//
// Each item is an <h3.item-list-name-box> with a sibling .price-area.
// The slot's broadcast date+time live in a .onair-time element belonging to
// the slot container — one .onair-time may cover several h3 items in the
// same slot. The text is "MM/DD (曜) HH:MM分放送".
//
// IMPORTANT: the page lists ~7 days of recent slots, not just today's. So
// air_date must come from the slot's .onair-time (with the current year),
// NOT from the jstDate argument — jstDate is only a fallback.
export function parseAsahiCategory(
	html: string,
	jstDate: string,
	channel: OAChannelSlug,
	url: string,
	sourceSheet: string,
): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];

	// Year context: the page omits the year, so assume jstDate's year and
	// roll back to the previous year for any MM/DD that lies in the future.
	const jstYear = parseInt(jstDate.slice(0, 4), 10);
	const jstMonthDay = jstDate.slice(5); // "MM-DD"

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

		// Walk up the DOM to find the slot container — the lowest ancestor
		// holding a .onair-time that precedes this h3 in document order.
		let scope = h3.parent();
		let onairText = "";
		for (let level = 0; level < 8 && scope.length; level++) {
			const ot = scope.find(".onair-time").first();
			if (ot.length) {
				const all = scope.find("*");
				const otIdx = all.index(ot[0]);
				const h3Idx = all.index(h3[0]);
				if (otIdx >= 0 && h3Idx >= 0 && otIdx < h3Idx) {
					onairText = ot.text().replace(/\s+/g, " ").trim();
					break;
				}
			}
			scope = scope.parent();
		}

		// Parse "05/15 (金) 04:30分放送" → start_time + air_date
		let startTime: string | null = null;
		let airDate = jstDate;
		const m = onairText.match(/(\d{1,2})\/(\d{1,2}).*?(\d{1,2}):(\d{2})\s*分?放送/);
		if (m) {
			const mm = m[1].padStart(2, "0");
			const dd = m[2].padStart(2, "0");
			startTime = `${m[3].padStart(2, "0")}:${m[4]}:00`;
			// Roll back a year if the MM/DD is in the future relative to jstDate
			const candidate = `${mm}-${dd}`;
			const year = candidate > jstMonthDay ? jstYear - 1 : jstYear;
			airDate = `${year}-${mm}-${dd}`;
		}

		rows.push({
			channel,
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: startTime,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, url).toString() : url,
			source_sheet: sourceSheet,
			image_url: null,
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
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		const rows = parseAsahiCategory(r.body, jstDate, "senobura", PAGE_URL, "live-crawl:senobura");
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
