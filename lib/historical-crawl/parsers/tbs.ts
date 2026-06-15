import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { parseJpMonthDay } from "../section-date";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

const PAGE_URL = "https://shopping.tbs.co.jp/tbs/shop/tv_top/kininaru";

/**
 * TBSキニナル groups products under a `p.text--on-air-date` header
 * ("6月16日（火）放送"), one section per broadcast day. Each `div.p-card__body`
 * belongs to the most recent preceding header — its real broadcast date.
 *
 * The previous implementation stamped every card with the cron's `jstDate`,
 * collapsing all listed days onto one. Walk headers + cards in document order
 * and stamp each card with its section's date instead. Idempotent upsert on
 * UNIQUE(channel, air_date, product_name) keeps daily reruns self-healing.
 */
export function parseTbs(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	let currentDate: string | null = null;

	$("p.text--on-air-date, div.p-card__body").each((_, el) => {
		const e = $(el);

		if (e.is("p.text--on-air-date")) {
			const d = parseJpMonthDay(e.text(), jstDate);
			if (d) currentDate = d;
			return;
		}

		// div.p-card__body — skip cards before the first dated header.
		if (!currentDate) return;
		const airDate = currentDate;

		const name = e.find(".text--truncate3line").first().text().replace(/\s+/g, " ").trim();
		if (!name || name.length < 3) return;

		const href = e.find("a[href]").first().attr("href") ?? "";
		const priceText = e.find(".text--original-price").first().text().replace(/\s+/g, " ").trim();
		const { price, incl } = parsePrice(priceText);

		rows.push({
			channel: "tbs",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: priceText ? priceText.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:tbs",
			image_url: null,
		});
	});

	return rows;
}

export const tbsParser: ChannelParser = {
	slug: "tbs",
	name: "TBSキニナル",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		const rows = parseTbs(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
