import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";

/**
 * Ropping (テレビ朝日グループ ロッピング) — `product_onair_list` page on
 * ropping.jp lists all products airing today (and sometimes the upcoming
 * couple of days) as repeated `.c-product-card` blocks. Each card carries:
 *  - `.c-product-card__balloon` → "5月21日(木)" (the air date for that card)
 *  - `.c-product-card__name`    → product name
 *  - `a.c-product-card__link[href]` → product detail URL
 *  - `.c-product-card__image img[src]` → thumbnail (relative path)
 *  - `.price`                   → price text "¥8,980（税込）"
 *
 * This page is RETROSPECTIVE: it lists products that have already aired, from
 * today back ~30 days, with no future dates. The cron runs at 01:30 JST, when
 * nothing has aired yet that day, so the page holds zero cards for "today" —
 * matching on jstDate alone perpetually yields 0 rows. We therefore persist
 * every card whose balloon date is strictly BEFORE jstDate (yesterday and
 * back). UNIQUE(channel, air_date, product_name) makes the rolling ~30-day
 * capture idempotent and self-healing: missed days are backfilled on the next
 * run. Today's (not-yet-aired) and any future cards are skipped.
 */

const PAGE_URL = "https://ropping.jp/product_onair_list";

/**
 * Parse "5月21日(木)" or "5月21日" or "12月3日(火)" into a JST air_date.
 * Uses the year inferred from jstDate to avoid Dec/Jan crossings ambiguity.
 */
function parseBalloonDate(balloon: string, jstDate: string): string | null {
	const m = balloon.normalize("NFKC").match(/(\d{1,2})月(\d{1,2})日/);
	if (!m) return null;
	const month = parseInt(m[1], 10);
	const day = parseInt(m[2], 10);
	if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
	const [refY, refM] = jstDate.split("-").map((x) => parseInt(x, 10));
	// If the balloon month is much smaller than current month (Dec/Jan flip),
	// assume next-year; if much larger, assume previous-year. Within the same
	// half of the year, assume current year.
	let year = refY;
	if (month - refM < -6) year = refY + 1;
	else if (month - refM > 6) year = refY - 1;
	const mm = String(month).padStart(2, "0");
	const dd = String(day).padStart(2, "0");
	return `${year}-${mm}-${dd}`;
}

export function parse(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];

	$(".c-product-card").each((_, el) => {
		const card = $(el);
		const balloon = card.find(".c-product-card__balloon").first().text().trim();
		const airDate = parseBalloonDate(balloon, jstDate);
		// Retrospective page: persist already-aired days (strictly before today).
		// Today hasn't aired at cron time (01:30 JST) and future dates never
		// appear; ISO YYYY-MM-DD compares correctly as strings.
		if (!airDate || airDate >= jstDate) return;

		const name = card
			.find(".c-product-card__name")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		if (!name || name.length < 3) return;

		const link = card.find("a.c-product-card__link").first();
		const href = link.attr("href") ?? "";
		const sourceUrl = href ? new URL(href, PAGE_URL).toString() : null;

		const imgSrc = card.find(".c-product-card__image img").first().attr("src") ?? "";
		const imageUrl = imgSrc ? new URL(imgSrc, PAGE_URL).toString() : null;

		const priceText = card
			.find(".c-product-card__prices .price")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		const { price, incl } = parsePrice(priceText);

		rows.push({
			channel: "ropping",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: null, // ropping doesn't publish per-slot times
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: sourceUrl,
			source_sheet: "live-crawl:ropping",
			image_url: imageUrl,
		});
	});

	return rows;
}

export const roppingParser: ChannelParser = {
	slug: "ropping",
	name: "ロッピング",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		return parse(r.body, jstDate);
	},
};

export const __test = { parseBalloonDate, parse };
