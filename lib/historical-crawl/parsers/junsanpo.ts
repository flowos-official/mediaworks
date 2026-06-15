import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { parseJpMonthDay } from "../section-date";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

const PAGE_URL = "https://ropping.tv-asahi.co.jp/junsanpo/";

/**
 * テレ朝じゅん散歩 (ropping.tv-asahi.co.jp/junsanpo) is a RETROSPECTIVE listing:
 * products are grouped under a `p.c-product-card__balloon` date header
 * ("6月15日(月)") spanning ~3 weeks back. Each `div.c-product-card__inner`
 * belongs to the most recent preceding balloon — its real broadcast date.
 *
 * The previous implementation stamped every card with the cron's `jstDate`,
 * which mis-filed all ~3 weeks of products onto one day (the same product then
 * appears on every day the cron ran). Walk balloons + cards in document order
 * and stamp each card with its balloon's date instead — same per-section
 * dating discipline ntv/senobura/ropping use. Idempotent upsert on
 * UNIQUE(channel, air_date, product_name) makes daily reruns self-healing.
 */
export function parseJunsanpo(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	let currentDate: string | null = null;

	$("p.c-product-card__balloon, div.c-product-card__inner").each((_, el) => {
		const e = $(el);

		if (e.is("p.c-product-card__balloon")) {
			const d = parseJpMonthDay(e.text(), jstDate);
			if (d) currentDate = d;
			return;
		}

		// div.c-product-card__inner — skip cards before the first dated balloon.
		if (!currentDate) return;
		const airDate = currentDate;

		const link = e.find("a.c-product-card__link").first();
		const desc = e.find("p.c-product-card__description").text().replace(/\s+/g, " ").trim();
		const title = e.find(".c-product-card__title, .c-product-card__name").text().trim() || desc;
		if (!title || title.length < 3) return;

		const { price, incl } = parsePrice(desc);
		// Only persist price_text when parsePrice found a JPY value (the description
		// is otherwise a marketing blurb that would render as a fake price).
		const priceText = price != null ? desc : null;
		const href = link.attr("href") ?? "";

		rows.push({
			channel: "junsanpo",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
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
		const rows = parseJunsanpo(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
