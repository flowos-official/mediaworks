import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { parseSlashMonthDay } from "../section-date";
import { mapWithConcurrency } from "../image-extractors/types";

/**
 * カンテレSHOPPING (関西テレビハッズ — ktvolm.jp). The operator confirmed
 * (2026-06-19) that this is THREE distinct programs, each on its own page with
 * its own OA schedule. We scrape all three and stamp each product with the
 * correct broadcast date + start time:
 *
 *  1. 真夜中市場            /shop/mayonaka         毎週金 深夜2:20〜  (start 02:20)
 *  2. 通販スターDaily Selection /shop/daily-selection 毎週土 早朝5:07〜  (start 05:07)
 *  3. 通販スターdaily       /shop/daily            月11:19 / 火〜金11:23 (start 11:19)
 *
 * Pages 1 & 2 are Drupal exposed-filter views: a `.c-foundMenu` dropdown links
 * each broadcast date ("6/12(金)", "06/13(土)") to a filter id
 * (`?field_onair_dates_target_id_entityreference_filter=<id>`). We read the
 * date→id map, fetch each date's listing, and stamp its real date. The default
 * listing's date is labelled in `.c-foundMenu__current`; we capture it under
 * that date so the newest broadcast isn't lost, and drop filter pages whose
 * product set equals the default (genuine dead ids). NB: the Saturday dates we
 * used to drop as "dead ids" on the old homepage parser were actually Daily
 * Selection broadcasts living on /shop/daily-selection — they ARE real here.
 *
 * Page 3 (通販スターdaily) has no per-date filter: it shows one weekly set
 * labelled "MM/DD(月) ～ MM/DD(金)". Since the page exposes no per-weekday
 * breakdown, we stamp the whole set on the week-start Monday (the schedule's
 * first air day). Its products live in a plain product list, not a
 * shop_products view, so we scope by excluding the ranking/swiper carousels.
 *
 * Scoping (avoids evergreen promo carousels — the old "stamps ~36 promo cards
 * on every date" bug): exposed-filter pages read only the FIRST
 * `view-display-id-shop_products_section` instance; the weekly page reads
 * `a.c-card` outside `.p-productRanking`/`.swiper-slide`. Idempotent upsert on
 * UNIQUE(channel, air_date, product_name) keeps daily reruns self-healing.
 */
const BASE_URL = "https://ktvolm.jp/";
const FILTER_PARAM = "field_onair_dates_target_id_entityreference_filter";
const MAX_DATES = 20; // bound the per-page fan-out (each page exposes ~5 dates).
// The exposed-filter results view (1st instance) — the dated set on pages 1 & 2.
const RESULTS_SELECTOR =
	"div.view-id-shop_products_list.view-display-id-shop_products_section";
// The default/weekly listing's labelled date ("6/12(金)" or "06/15(月) ～ …").
// Class-only (not `p.`) so it matches both the <p> (mayonaka) and <div> (daily).
const CURRENT_DATE_SELECTOR = ".c-foundMenu__current";

// Per-program config. start times are operator-confirmed (2026-06-19).
const MAYONAKA_URL = "https://ktvolm.jp/shop/mayonaka";
const SELECTION_URL = "https://ktvolm.jp/shop/daily-selection";
const DAILY_URL = "https://ktvolm.jp/shop/daily";

/** Stable identity of a page's dated listing — sorted product names. Used to
 * detect filter pages that fell back to the default (latest-day) listing. */
function listingFingerprint(rows: HistoricalRow[]): string {
	return rows
		.map((r) => r.product_name)
		.sort()
		.join("");
}

/** Read the listing's labelled broadcast date from `.c-foundMenu__current`
 * ("6/12(金)", or "06/15(月) ～ 06/19(金)" whose FIRST date is the week-start
 * Monday). Returns null when absent/unparseable so callers don't false-date. */
export function extractCurrentBroadcastDate(html: string, jstDate: string): string | null {
	const $ = cheerio.load(html);
	const text = $(CURRENT_DATE_SELECTOR).first().text();
	return parseSlashMonthDay(text, jstDate);
}

/** Extract { airDate, id } for each dated filter link on an exposed-filter page. */
export function extractDateFilters(html: string, jstDate: string): { airDate: string; id: string }[] {
	const $ = cheerio.load(html);
	const byDate = new Map<string, string>();
	$(`a[href*='${FILTER_PARAM}=']`).each((_, el) => {
		const href = $(el).attr("href") ?? "";
		const id = href.match(new RegExp(`${FILTER_PARAM}=(\\d+)`))?.[1];
		const airDate = parseSlashMonthDay($(el).text(), jstDate);
		if (id && airDate && !byDate.has(airDate)) byDate.set(airDate, id);
	});
	return [...byDate.entries()].map(([airDate, id]) => ({ airDate, id })).slice(0, MAX_DATES);
}

/** Parse a page's product cards, stamping the given broadcast date + start time.
 * `scope="view"` reads only the first exposed-filter results view (pages 1 & 2);
 * `scope="list"` reads `a.c-card` outside the ranking/swiper carousels (page 3). */
export function parseKantv(
	html: string,
	airDate: string,
	startTime: string | null = null,
	scope: "view" | "list" = "view",
): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	const seen = new Set<string>();

	const cards =
		scope === "view"
			? $(RESULTS_SELECTOR).first().find("a.c-card")
			: $("a.c-card").filter((_, el) => $(el).closest(".p-productRanking, .swiper-slide").length === 0);

	cards.each((_, el) => {
		const card = $(el);
		const name = card.find(".c-card__title").first().text().replace(/\s+/g, " ").trim();
		if (!name || name.length < 3 || seen.has(name)) return;
		seen.add(name);

		const href = card.attr("href") ?? "";
		const imgSrc = card.find(".c-card__img img").first().attr("src") ?? "";
		// Price lives in its own element ("11,000 円 (税込)"); parsePrice reads the
		// tax flag from the suffix. Fall back to desc/info for older markup.
		const priceText = (
			card.find(".c-card__price").first().text() ||
			card.find(".c-card__desc, .c-card__info").first().text()
		).replace(/\s+/g, " ").trim();
		const { price, incl } = parsePrice(priceText);

		rows.push({
			channel: "kantv",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: startTime,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, BASE_URL).toString() : null,
			source_sheet: "live-crawl:kantv",
			image_url: imgSrc ? new URL(imgSrc, BASE_URL).toString() : null,
		});
	});

	return rows;
}

/** Scrape an exposed-filter program page (真夜中市場 / Daily Selection): capture
 * the labelled default date directly, then each filter date's listing, dropping
 * dead-id pages whose product set equals the default. */
async function scrapeFiltered(pageUrl: string, jstDate: string, startTime: string): Promise<HistoricalRow[]> {
	const page = await politeFetch(pageUrl);
	if (!page.ok || !page.body) {
		throw new Error(`fetch failed (${pageUrl}): HTTP ${page.status ?? "?"}${page.error ? ` ${page.error}` : ""}`);
	}
	const filters = extractDateFilters(page.body, jstDate);
	const fallbackPrint = listingFingerprint(parseKantv(page.body, jstDate));
	const defaultDate = extractCurrentBroadcastDate(page.body, jstDate);
	const defaultRows = defaultDate ? parseKantv(page.body, defaultDate, startTime) : [];
	const perDate = await mapWithConcurrency(filters, 3, async (f) => {
		// The labelled default date is already captured; its filter page is the
		// fallback content, so skip it.
		if (defaultDate && f.airDate === defaultDate) return [] as HistoricalRow[];
		const r = await politeFetch(`${pageUrl}?${FILTER_PARAM}=${f.id}`);
		if (!r.ok || !r.body) return [] as HistoricalRow[];
		const rows = parseKantv(r.body, f.airDate, startTime);
		if (rows.length === 0) return rows;
		if (listingFingerprint(rows) === fallbackPrint) return [] as HistoricalRow[];
		return rows;
	});
	return [...defaultRows, ...perDate.flat()];
}

/** Scrape the weekly daily program (通販スターdaily): one set labelled
 * "MM/DD(月) ～ MM/DD(金)", stamped on the week-start Monday. */
async function scrapeWeekly(pageUrl: string, jstDate: string, startTime: string): Promise<HistoricalRow[]> {
	const page = await politeFetch(pageUrl);
	if (!page.ok || !page.body) {
		throw new Error(`fetch failed (${pageUrl}): HTTP ${page.status ?? "?"}${page.error ? ` ${page.error}` : ""}`);
	}
	const weekStart = extractCurrentBroadcastDate(page.body, jstDate);
	if (!weekStart) return []; // no label → don't blanket-stamp
	return parseKantv(page.body, weekStart, startTime, "list");
}

export const kantvParser: ChannelParser = {
	slug: "kantv",
	name: "カンテレSHOPPING",
	fetchToday: async (jstDate) => {
		const settled = await Promise.allSettled([
			scrapeFiltered(MAYONAKA_URL, jstDate, "02:20:00"),
			scrapeFiltered(SELECTION_URL, jstDate, "05:07:00"),
			scrapeWeekly(DAILY_URL, jstDate, "11:19:00"),
		]);
		const rows: HistoricalRow[] = [];
		const errors: string[] = [];
		for (const r of settled) {
			if (r.status === "fulfilled") rows.push(...r.value);
			else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
		}
		// Per-program failures don't kill the others; only a total failure throws
		// (so crawl-alert fires) rather than silently emitting zero.
		if (rows.length === 0 && errors.length === settled.length) {
			throw new Error(`all kantv programs failed: ${errors.join("; ")}`);
		}
		return rows;
	},
};

export const __test = { parseKantv, extractDateFilters, extractCurrentBroadcastDate, listingFingerprint };
