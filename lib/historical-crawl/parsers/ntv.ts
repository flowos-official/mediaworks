import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";
import { parsePrice } from "../price";
import { ntvApiExtractor } from "../image-extractors/ntv-api";
import { mapWithConcurrency } from "../image-extractors/types";

const PAGE_URL = "https://shop.ntv.co.jp/s/tvshopping/";

/**
 * The ntv (日テレポシュレ) tvshopping page lists SEVERAL broadcast days at once,
 * each under a section header span such as "昼6/11(木)放送の商品" /
 * "GOLD6/12(金)放送の商品" / "深夜6/15(月)放送の商品". The prefix (昼/朝/深夜/
 * GOLD/BS) is the program block; the date is what matters.
 *
 * Each product must be stamped with its SECTION's date, NOT the cron's run
 * date. The previous implementation stamped every card with `jstDate`, which
 * mis-filed all ~5 days of products onto whatever day the cron happened to run
 * — so a product aired on 6/11 would show up on 6/12..6/15 (the days the cron
 * ran while the section was still listed) and never on 6/11. This is the same
 * per-slot dating discipline senobura/ropping already use.
 *
 * Because the page retains ~5 days of sections and UNIQUE(channel, air_date,
 * product_name) makes upserts idempotent, the rolling window self-heals: a day
 * missed at 01:30 JST (before its afternoon section is published) is backfilled
 * with the correct date on the following days' runs.
 *
 * Items appearing before the first dated header (the 通販王決定戦 / 三ツ星モール
 * ranking carousel) carry no broadcast date and are skipped.
 */

// "昼6/11(木)放送の商品" → groups: month, day, optional day-of-week char.
const HEADER_RE = /(\d{1,2})\/(\d{1,2})\s*(?:\(([日月火水木金土])\))?\s*放送の商品/;

/**
 * Resolve a year-less "M/D" header to a full YYYY-MM-DD, choosing the year
 * (ref-1 / ref / ref+1) whose date lands closest to the reference (cron) date.
 * This disambiguates Dec/Jan boundary crossings without guesswork.
 */
export function resolveHeaderDate(month: number, day: number, refDate: string): string {
	const [ry, rm, rd] = refDate.split("-").map((x) => parseInt(x, 10));
	const refUTC = Date.UTC(ry, rm - 1, rd);
	const mm = String(month).padStart(2, "0");
	const dd = String(day).padStart(2, "0");
	let best: { iso: string; diff: number } | null = null;
	for (const y of [ry - 1, ry, ry + 1]) {
		const diff = Math.abs(Date.UTC(y, month - 1, day) - refUTC);
		if (!best || diff < best.diff) best = { iso: `${y}-${mm}-${dd}`, diff };
	}
	return best!.iso;
}

export function parseNtv(html: string, jstDate: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	let currentDate: string | null = null;

	// Headers and product cards in document order. cheerio returns a union
	// selector's matches in document order, so the most recently seen dated
	// header is always the section the following block-items belong to.
	$("span.bg-white, div.block-item").each((_, el) => {
		const e = $(el);

		if (!e.is("div.block-item")) {
			// header span — match on OWN text (date lives directly in the span,
			// never via a descendant) so wrapper spans don't grab the date.
			const own = e.clone().children().remove().end().text().replace(/\s+/g, " ").trim();
			const m = HEADER_RE.exec(own);
			if (m) currentDate = resolveHeaderDate(parseInt(m[1], 10), parseInt(m[2], 10), jstDate);
			return;
		}

		// div.block-item — skip the undated leading carousel and any nested card.
		if (!currentDate) return;
		if (e.parents("div.block-item").length > 0) return;
		const airDate = currentDate;

		const name = e
			.find("p.text-14px, p.sm\\:line-clamp-3")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		if (!name || name.length < 3) return;

		const link = e.find("a[href*='/item/']").first();
		const href = link.attr("href") ?? "";
		const rawPrice = e.find("[data-js='wrap-price']").first().text().replace(/\s+/g, " ").trim();
		const { price, incl } = parsePrice(rawPrice);

		rows.push({
			channel: "ntv",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			start_time: null,
			product_name: name.slice(0, 500),
			price_text: rawPrice ? rawPrice.slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: href ? new URL(href, PAGE_URL).toString() : PAGE_URL,
			source_sheet: "live-crawl:ntv",
			image_url: null,
		});
	});

	return rows;
}

export const ntvParser: ChannelParser = {
	slug: "ntv",
	name: "日テレポシュレ",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		const rows = parseNtv(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ntvApiExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
