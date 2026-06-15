import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { parseSlashMonthDay } from "../section-date";
import { mapWithConcurrency } from "../image-extractors/types";

/**
 * KanTV (関西テレビハッズ / カンテレSHOPPING — ktvolm.jp). The homepage shows
 * only the latest broadcast day's products, so the old parser stamped every
 * card with the cron's jstDate — one product then appeared on every day the
 * cron ran. The site exposes a per-date filter though:
 *   /?field_onair_dates_target_id_entityreference_filter=<id>
 * and the homepage links each date label ("6/12(金)") to its filter id. We
 * scrape that date→id map, fetch each date's page, and stamp products with the
 * filter's real broadcast date. Idempotent upsert keeps reruns self-healing.
 */
const HOME_URL = "https://ktvolm.jp/";
const FILTER_PARAM = "field_onair_dates_target_id_entityreference_filter";
const MAX_DATES = 20; // bound the fan-out; the homepage exposes ~10 date filters.

/** Extract { airDate, id } for each dated filter link on the homepage. */
export function extractDateFilters(homeHtml: string, jstDate: string): { airDate: string; id: string }[] {
	const $ = cheerio.load(homeHtml);
	const byDate = new Map<string, string>();
	$(`a[href*='${FILTER_PARAM}=']`).each((_, el) => {
		const href = $(el).attr("href") ?? "";
		const id = href.match(new RegExp(`${FILTER_PARAM}=(\\d+)`))?.[1];
		const airDate = parseSlashMonthDay($(el).text(), jstDate);
		if (id && airDate && !byDate.has(airDate)) byDate.set(airDate, id);
	});
	return [...byDate.entries()].map(([airDate, id]) => ({ airDate, id })).slice(0, MAX_DATES);
}

/** Parse one filter page's product cards, stamping the given broadcast date. */
export function parseKantv(html: string, airDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	const seen = new Set<string>();

	$("a.c-card").each((_, el) => {
		const card = $(el);
		const name = card.find(".c-card__title").first().text().replace(/\s+/g, " ").trim();
		if (!name || name.length < 3 || seen.has(name)) return;
		seen.add(name);

		const href = card.attr("href") ?? "";
		const imgSrc = card.find(".c-card__img img").first().attr("src") ?? "";
		const descText = card.find(".c-card__desc, .c-card__info").first().text();
		const priceMatch = descText.match(/¥[\d,]+|[\d,]{4,}円/);
		const priceText = priceMatch ? priceMatch[0] : "";
		const { price, incl } = parsePrice(priceText);

		rows.push({
			channel: "kantv",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, HOME_URL).toString() : null,
			source_sheet: "live-crawl:kantv",
			image_url: imgSrc ? new URL(imgSrc, HOME_URL).toString() : null,
		});
	});

	return rows;
}

export const kantvParser: ChannelParser = {
	slug: "kantv",
	name: "カンテレSHOPPING",
	fetchToday: async (jstDate) => {
		const home = await politeFetch(HOME_URL);
		if (!home.ok || !home.body) throw new Error(`fetch failed: HTTP ${home.status ?? "?"}${home.error ? ` ${home.error}` : ""}`);
		const filters = extractDateFilters(home.body, jstDate);
		if (filters.length === 0) {
			// Fallback: no date filters found — parse the homepage as the latest day.
			return parseKantv(home.body, jstDate);
		}
		const perDate = await mapWithConcurrency(filters, 3, async (f) => {
			const r = await politeFetch(`${HOME_URL}?${FILTER_PARAM}=${f.id}`);
			if (!r.ok || !r.body) return [] as HistoricalRow[];
			return parseKantv(r.body, f.airDate);
		});
		return perDate.flat();
	},
};

export const __test = { parseKantv, extractDateFilters };
