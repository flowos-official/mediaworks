import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";

/**
 * KanTV (関西テレビハッズ / カンテレSHOPPING — ktvolm.jp). The site's
 * homepage shows the products currently on-air, with each `.c-card` linking
 * to a product page. Air dates are NOT directly attached to each card —
 * instead there's a sidebar of date filters like
 * `?field_onair_dates_target_id_entityreference_filter=4399` that map to
 * "5/15(金)" etc.
 *
 * For first-cut data collection we accept the limitation that
 * homepage-captured products are "currently on-air this week" rather than
 * "on-air exactly today." Daily cron runs accumulate week-spanning rows
 * dated to capture-day; the UNIQUE(channel, air_date, product_name)
 * constraint deduplicates within a single day. Result: tv-evidence picks
 * up brand+model matches that aired in the last few weeks — still a much
 * stronger signal than the data-limited fallback.
 *
 * If higher day-level precision is needed later, fetch each date-filter
 * URL individually and assign rows to that filter's parsed date.
 */

const HOME_URL = "https://ktvolm.jp/";

export function parse(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	const seenNames = new Set<string>();

	$("a.c-card").each((_, el) => {
		const card = $(el);
		const href = card.attr("href") ?? "";
		const sourceUrl = href ? new URL(href, HOME_URL).toString() : null;

		const name = card
			.find(".c-card__title")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		if (!name || name.length < 3) return;

		// Card layout repeats brand/title across multiple sliders. Dedup by
		// name within this single fetch so the UNIQUE constraint doesn't have
		// to absorb obvious duplicates.
		if (seenNames.has(name)) return;
		seenNames.add(name);

		// Brand chip is in .c-card__img__bland (kept for traceability — not
		// used directly in HistoricalRow).
		const imgSrc = card.find(".c-card__img img").first().attr("src") ?? "";
		const imageUrl = imgSrc ? new URL(imgSrc, HOME_URL).toString() : null;

		// Price is in .c-card__desc or a price span. Grab the first ¥ token.
		const descText = card.find(".c-card__desc, .c-card__info").first().text();
		const priceMatch = descText.match(/¥[\d,]+|[\d,]{4,}円/);
		const priceText = priceMatch ? priceMatch[0] : "";
		const { price, incl } = parsePrice(priceText);

		rows.push({
			channel: "kantv",
			air_date: jstDate,
			day_of_week: dayOfWeekJp(jstDate),
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: sourceUrl,
			source_sheet: "live-crawl:kantv",
			image_url: imageUrl,
		});
	});

	return rows;
}

export const kantvParser: ChannelParser = {
	slug: "kantv",
	name: "カンテレSHOPPING",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(HOME_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		return parse(r.body, jstDate);
	},
};

export const __test = { parse };
