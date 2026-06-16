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
 *
 * Two pitfalls the parser must dodge (verified live 2026-06-16):
 *  1. **Evergreen promo blocks.** Every page renders several product carousels
 *     besides the dated results: a 2nd `shop_products_section` instance, a
 *     `versatility_products_section` view, plus 通販スターDaily / recommendation
 *     / ranking blocks. A global `a.c-card` sweep stamps ~36 promo products on
 *     EVERY date. Fix: read only the FIRST
 *     `view-display-id-shop_products_section` instance (the exposed-filter
 *     results), whose card count tracks the selected date.
 *  2. **Dead filter ids.** Roughly half the dropdown dates (the 土 entries)
 *     carry term ids the view doesn't recognise; passing them silently returns
 *     the DEFAULT (latest-day) listing instead of that date's. Those pages are
 *     indistinguishable from a real page except by content — title, canonical,
 *     og:url and dropdown state are identical. Fix: treat the homepage's own
 *     listing as the "fallback fingerprint" and drop any filter page whose
 *     product set equals it. This also drops the latest real date (its listing
 *     == default); that date is captured on a later run once a newer broadcast
 *     pushes it off the default — idempotent upsert backfills it. The trade is
 *     deliberate: a few days' lag on the newest date in exchange for zero
 *     false-dated rows, which is the calendar's stated priority.
 */
const HOME_URL = "https://ktvolm.jp/";
const FILTER_PARAM = "field_onair_dates_target_id_entityreference_filter";
const MAX_DATES = 20; // bound the fan-out; the homepage exposes ~10 date filters.
// Only the exposed-filter results live here; the 1st instance is the dated set.
const RESULTS_SELECTOR =
	"div.view-id-shop_products_list.view-display-id-shop_products_section";

/** Stable identity of a page's dated listing — sorted product names. Used to
 * detect filter pages that fell back to the default (latest-day) listing. */
function listingFingerprint(rows: HistoricalRow[]): string {
	return rows
		.map((r) => r.product_name)
		.sort()
		.join("");
}

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

/** Parse one filter page's product cards, stamping the given broadcast date.
 * Scopes to the FIRST exposed-filter results view so evergreen promo carousels
 * elsewhere on the page are ignored. */
export function parseKantv(html: string, airDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	const seen = new Set<string>();

	const results = $(RESULTS_SELECTOR).first();
	results.find("a.c-card").each((_, el) => {
		const card = $(el);
		const name = card.find(".c-card__title").first().text().replace(/\s+/g, " ").trim();
		if (!name || name.length < 3 || seen.has(name)) return;
		seen.add(name);

		const href = card.attr("href") ?? "";
		const imgSrc = card.find(".c-card__img img").first().attr("src") ?? "";
		// Price lives in its own element ("11,000 円 (税込)"); parsePrice reads
		// the tax flag from the suffix. Fall back to desc/info for older markup.
		const priceText = (
			card.find(".c-card__price").first().text() ||
			card.find(".c-card__desc, .c-card__info").first().text()
		).replace(/\s+/g, " ").trim();
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
			// No date filters means we cannot attribute the listing to a real
			// broadcast date — stamping jstDate is exactly the blanket bug we
			// fixed, so emit nothing rather than pollute the calendar.
			return [];
		}
		// The homepage's own dated listing is what a dead-id filter falls back
		// to; pages matching it carry no date-specific data.
		const fallbackPrint = listingFingerprint(parseKantv(home.body, jstDate));
		const perDate = await mapWithConcurrency(filters, 3, async (f) => {
			const r = await politeFetch(`${HOME_URL}?${FILTER_PARAM}=${f.id}`);
			if (!r.ok || !r.body) return [] as HistoricalRow[];
			const rows = parseKantv(r.body, f.airDate);
			if (rows.length === 0) return rows;
			if (listingFingerprint(rows) === fallbackPrint) return [] as HistoricalRow[];
			return rows;
		});
		return perDate.flat();
	},
};

export const __test = { parseKantv, extractDateFilters, listingFingerprint };
