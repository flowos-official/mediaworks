import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parseSlashMonthDay } from "../section-date";
import { parsePrice } from "../price";
import { mapWithConcurrency } from "../image-extractors/types";

/**
 * フジDinos (いいものプレミアム). The product grid at /tv/premium only renders
 * the current day's broadcast, so the old parser stamped every card with the
 * cron's jstDate — a product featured for days then appeared on each of them.
 * The monthly schedule page lists one entry per broadcast day with the real
 * date in each item's image alt ("6/1（月）放送　クリアージュ アイリフトNeo")
 * plus a /p/ product link. Parse that instead so every product carries its
 * true air date.
 *
 * The schedule page exposes only date + name + thumbnail (no price). Operator
 * feedback (2026-06-18) flagged Dinos entries as info-thin. The dinos.co.jp/tv
 * pages don't structure per-product broadcast times or additional distinct
 * broadcasts (verified by rendering /tv/premium_s/ — its "9:50-11:25" is the
 * parent ノンストップ! airtime window, and its extra cards are related/
 * recommended items, not separate broadcasts). The genuinely missing field is
 * PRICE, which lives on each product's /p/ detail page. So fetchToday enriches
 * every parsed row from its /p/ page: price (product:price:amount meta, with
 * the .box-cart-price-01 "税込" text for the tax flag) + a higher-quality
 * og:image. parseDinos stays date+name+link only; enrichment is layered on top.
 */
const PAGE_URL = "https://www.dinos.co.jp/tv/premium_schedule_s/";
// "6/1（月）放送　<name>" — full-width or ASCII paren/space; capture the name tail.
const ALT_RE = /\d{1,2}\/\d{1,2}[（(][日月火水木金土][)）]\s*放送[\s　]*(.+)$/;

export function parseDinos(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	const seen = new Set<string>();

	$("a[href*='/p/']").each((_, el) => {
		const a = $(el);
		const img = a.find("img[alt]").first();
		const alt = (img.attr("alt") ?? "").replace(/　/g, " ").replace(/\s+/g, " ").trim();
		const airDate = parseSlashMonthDay(alt, jstDate);
		if (!airDate) return; // non-broadcast links (e.g. social) have no dated alt

		const name = ALT_RE.exec(alt)?.[1]?.trim() ?? "";
		if (!name || name.length < 3) return;

		const key = `${airDate}|${name}`;
		if (seen.has(key)) return;
		seen.add(key);

		const href = a.attr("href") ?? "";
		const imgSrc = img.attr("src") ?? "";

		rows.push({
			channel: "dinos",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: null,
			price_jpy: null,
			price_is_tax_incl: null,
			source_url: href ? new URL(href, PAGE_URL).toString() : null,
			source_sheet: "live-crawl:dinos",
			image_url: imgSrc ? new URL(imgSrc, PAGE_URL).toString() : null,
		});
	});

	return rows;
}

export interface DinosProductDetail {
	price_jpy: number | null;
	price_text: string | null;
	price_is_tax_incl: boolean | null;
	image_url: string | null;
}

/**
 * Parse price + image from a Dinos /p/ product detail page (server-rendered).
 * Price source of truth is the `product:price:amount` meta (clean integer);
 * the `.box-cart-price-01` text ("¥5,980 税込") provides the tax-inclusive flag.
 * Image upgrades to og:image when present. Pure — returns nulls on any miss.
 */
export function parseDinosProductDetail(html: string, url: string): DinosProductDetail {
	const $ = cheerio.load(html);

	const amount = $('meta[property="product:price:amount"]').first().attr("content")?.trim();
	const cartText = $(".box-cart-price-01").first().text().replace(/\s+/g, " ").trim();
	const { price: parsedPrice, incl: parsedIncl } = parsePrice(cartText);

	const metaPrice = amount && /^\d+$/.test(amount) ? parseInt(amount, 10) : null;
	const price_jpy = metaPrice ?? parsedPrice;
	const price_is_tax_incl = parsedIncl ?? (cartText.includes("税込") ? true : null);

	const og = $('meta[property="og:image"]').first().attr("content")?.trim();
	let image_url: string | null = null;
	if (og) {
		try {
			const u = new URL(og, url);
			if (u.protocol === "https:" || u.protocol === "http:") image_url = u.toString();
		} catch {
			/* ignore malformed og:image */
		}
	}

	return {
		price_jpy,
		price_text: cartText || (price_jpy != null ? `¥${price_jpy}` : null),
		price_is_tax_incl,
		image_url,
	};
}

export const dinosParser: ChannelParser = {
	slug: "dinos",
	name: "フジDinos",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		const rows = parseDinos(r.body, jstDate);

		// Enrich each row from its /p/ detail page (price + better image). Failures
		// are non-fatal: the schedule-page thumbnail stays as the image fallback and
		// price remains null, so a flaky product page never drops a broadcast row.
		await mapWithConcurrency(rows, 4, async (row) => {
			if (!row.source_url) return;
			try {
				const d = await politeFetch(row.source_url);
				if (!d.ok || !d.body) return;
				const detail = parseDinosProductDetail(d.body, row.source_url);
				if (detail.price_jpy != null) {
					row.price_jpy = detail.price_jpy;
					row.price_text = detail.price_text;
					row.price_is_tax_incl = detail.price_is_tax_incl;
				}
				if (detail.image_url) row.image_url = detail.image_url;
			} catch {
				/* keep schedule-page image + null price on any fetch/parse failure */
			}
		});

		return rows;
	},
};
