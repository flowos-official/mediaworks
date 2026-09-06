import * as cheerio from "cheerio";
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";

// 楽天市場ショッピングチャンネル (event.rakuten.co.jp). Added 2026-09-06.
//
// This channel reached us the wrong way round first. It was registered as a
// DISCOVERY channel, searched daily with Brave `site:` queries, and produced
// exactly one row in its lifetime — the campaign landing page, stored as if it
// were a product. The reason is structural: Rakuten's live commerce happens
// inside the video stream, so there are no per-product pages for a keyword
// search to find. It is excluded from discovery now (EXCLUDED_DISCOVERY_SLUGS)
// and collected here instead, where the shape actually fits.
//
// What IS server-rendered is the archive list: `ul.category.-archiveList`
// holding `li.liveLink` items with a title, a date and a genre. The upcoming
// schedule on the same page is a JS template (`li#itemTemplate`, all fields
// empty) and cannot be read without a browser — so this parser deliberately
// takes only the archive, which is what historical_broadcasts is for anyway.
//
// CADENCE: Rakuten runs these once a month, on the 18th, ~13 broadcasts per
// event, and the page keeps a rolling three-month window (measured 2026-09-06:
// 6/18, 7/18, 8/18 — 13 each). So a daily crawl finds new rows once a month and
// re-reads the same 39 the rest of the time. That is fine and intended: the
// UNIQUE(channel, air_date, product_name) upsert makes the repeat a no-op, and
// a channel that only airs monthly is honestly represented by monthly rows.
//
// There is no price on the archive card — the offer lives in the stream — so
// the price fields stay null rather than being guessed at.
const PAGE_URL = "https://event.rakuten.co.jp/campaign/live-shopping/shop/";

/** `2026年8月18日` (the trailing `(火)` is present in some blocks and absent in
 *  others) → `2026-08-18`. Returns null rather than guessing a year: an undated
 *  card is not a broadcast we can place. */
export function parseJapaneseDate(text: string): string | null {
	const m = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(text.normalize("NFKC"));
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	// Round-tripped through UTC to reject 2026-02-31, without letting a timezone
	// touch the value that comes back.
	const probe = new Date(Date.UTC(year, month - 1, day));
	if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseRakutenLive(html: string): HistoricalRow[] {
	const $ = cheerio.load(html);
	const rows: HistoricalRow[] = [];
	const seen = new Set<string>();

	$("li.liveLink").each((_, el) => {
		const e = $(el);
		const productName = e.find(".liveLink__title").first().text().trim();
		const airDate = parseJapaneseDate(e.find(".liveLink__date").first().text());
		if (!productName || !airDate) return;

		// The same broadcast appears in both the top slider and the archive
		// list. Dedupe here so one crawl does not report double the rows it
		// actually found.
		const key = `${airDate} ${productName}`;
		if (seen.has(key)) return;
		seen.add(key);

		const href = e.find("a[href*='liveId=']").first().attr("href") ?? null;
		const image = e.find(".liveLink__image").first();

		rows.push({
			channel: "rakutenlive",
			air_date: airDate,
			day_of_week: dayOfWeekJp(airDate),
			// Per-broadcast start times exist only in the JS-filled schedule
			// block, not in the archive cards.
			start_time: null,
			product_name: productName,
			price_text: null,
			price_jpy: null,
			price_is_tax_incl: null,
			source_url: href,
			source_sheet: "live-crawl:rakutenlive",
			image_url: image.attr("data-lazy-loading") ?? image.attr("src") ?? null,
		});
	});

	return rows;
}

export const rakutenliveParser: ChannelParser = {
	slug: "rakutenlive",
	name: "楽天ショッピングチャンネル",
	async fetchToday(): Promise<HistoricalRow[]> {
		const res = await politeFetch(PAGE_URL, { retry: true });
		if (!res.ok || !res.body) {
			throw new Error(res.error ?? `fetch failed (${res.status ?? "no status"})`);
		}
		return parseRakutenLive(res.body);
	},
};
