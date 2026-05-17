import * as cheerio from "cheerio";
import { getServiceClient } from "@/lib/supabase";
import { politeFetch } from "./fetch";
import { computeHealth, type ScrapeResult, type ScrapedSlot } from "./types";

const BASE_HOST = "https://qvc.jp";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function formatYYYYMMDD(date: Date): string {
	return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function formatISODate(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Parse time from ISO 8601 datetime attribute (e.g. "2026-05-11T00:00:00+09:00") → "00:00:00"
 */
function timeFromISOString(raw: string): string | null {
	// Accepts "2026-05-11T00:00:00+09:00" or "2026-05-11T00:00:00Z"
	const m = raw.match(/T(\d{2}):(\d{2}):(\d{2})/);
	if (!m) return null;
	const h = parseInt(m[1], 10);
	const min = parseInt(m[2], 10);
	const s = parseInt(m[3], 10);
	if (h > 23 || min > 59 || s > 59) return null;
	return `${pad2(h)}:${pad2(min)}:${pad2(s)}`;
}

function absoluteUrl(href: string | undefined): string | null {
	if (!href) return null;
	if (href.startsWith("http")) return href;
	if (href.startsWith("//")) return `https:${href}`;
	if (href.startsWith("/")) return `${BASE_HOST}${href}`;
	return null;
}

/**
 * Build a source URL for a slot from its sourcecode attribute.
 * QVC sourcecode format: YYMMDDHHNN (e.g. "2605110000")
 * There is no per-show deep-link in the HTML, so we use the daily guide URL as source.
 */
function buildSourceUrl(yyyymmdd: string): string {
	return `${BASE_HOST}/content/programguide.qvc.${yyyymmdd}0000.html`;
}

/**
 * Pure HTML parser — takes the raw HTML of
 * qvc.jp/content/programguide.qvc.YYYYMMDD0000.html
 * and returns scraped slots for the given airDate.
 *
 * Structure observed in fixture (2026-05-11):
 *   li[data-starttime="2026-05-11T00:00:00+09:00"]
 *     [data-showname="..."]        → program_title (also in h3)
 *     [data-sourcecode="NNNNNNNNNN"] → used for source_url
 *     span.hostImg > img[src][alt] → thumbnail_url (src), presenter (alt)
 *     p.host                       → presenter (preferred; absent for TSV re-runs)
 *     p.hostTsv.hidden             → presenter fallback for TSV slots
 *     div.showDesc div.col-tn-12   → description
 */
export function scrapeQVCFromHTML(html: string, airDate: string): ScrapedSlot[] {
	const $ = cheerio.load(html);
	const slots: ScrapedSlot[] = [];

	// Guard against explicitly-empty pages.
	// Check for no-data message inside the show list container, not in JS i18n strings.
	const showListText = $(".showList, .programGuideDailyChannel").text();
	if (
		(showListText.includes("表示できる番組情報がありません") ||
			showListText.includes("番組情報はありません")) &&
		$("li[data-starttime]").length === 0
	) {
		return [];
	}

	const yyyymmdd = airDate.replace(/-/g, "");
	const pageSourceUrl = buildSourceUrl(yyyymmdd);
	// ISO date prefix used to filter li elements belonging to this day
	const isoPrefix = airDate; // e.g. "2026-05-11"

	$("li[data-starttime]").each((_, el) => {
		const $el = $(el);

		const rawStart = $el.attr("data-starttime") ?? "";
		// Only include slots that start on the requested date
		if (!rawStart.startsWith(isoPrefix)) return;

		const startTime = timeFromISOString(rawStart);
		if (!startTime) return;

		// Program title: prefer data-showname attribute (always present), fall back to h3
		const programTitle =
			$el.attr("data-showname")?.trim() ??
			$el.find("h3").first().text().trim();
		if (!programTitle) return;

		// Presenter: p.host (live), p.hostTsv (TSV/replay), then hostImg alt as final fallback
		const hostP = $el.find("p.host").first().text().trim();
		const hostTsv = $el.find("p.hostTsv").first().text().trim();
		const hostImgAlt = $el.find("span.hostImg img").first().attr("alt")?.trim() ?? "";
		const presenter: string | null =
			hostP || hostTsv || hostImgAlt || null;

		// Description: inside div.showDesc > div.col-tn-12
		const description =
			$el.find(".showDesc .col-tn-12").first().text().trim() || null;

		// Thumbnail: host/navigator image from span.hostImg img
		const thumbnailUrl = absoluteUrl(
			$el.find("span.hostImg img").first().attr("src"),
		);

		// Phase B PoC: data-products="754899|754900|..." → product ID list
		const rawProducts = $el.attr("data-products");
		const productIds: string[] | null = rawProducts
			? rawProducts
					.split("|")
					.map((s) => s.trim())
					.filter((s) => /^\d+$/.test(s))
			: null;

		slots.push({
			channel: "qvc",
			air_date: airDate,
			start_time: startTime,
			program_title: programTitle,
			presenter,
			description,
			thumbnail_url: thumbnailUrl,
			source_url: pageSourceUrl,
			product_ids: productIds && productIds.length > 0 ? productIds : null,
			category: null, // attached later by attachQVCCategories
		});
	});

	slots.sort((a, b) => a.start_time.localeCompare(b.start_time));
	return slots;
}

/**
 * For each slot, look up its first product id in `qvc_products` and attach
 * the cached category. Returns a new array (does not mutate input).
 *
 * Chicken-and-egg: brand-new products that haven't been enriched yet have
 * NULL category here. The daily `enrich:qvc-products` cron fills the cache
 * on a separate cadence, so today's slot may be dropped by the whitelist
 * filter and re-appear from tomorrow onward. Acceptable trade-off vs.
 * synchronous fetch fanout from inside the scraper.
 */
async function attachQVCCategories(slots: ScrapedSlot[]): Promise<ScrapedSlot[]> {
	if (slots.length === 0) return slots;
	const firstIds = slots
		.map((s) => s.product_ids?.[0])
		.filter((x): x is string => typeof x === "string" && x.length > 0);
	if (firstIds.length === 0) return slots;

	const sb = getServiceClient();
	const { data, error } = await sb
		.from("qvc_products")
		.select("id, category")
		.in("id", firstIds);
	if (error) {
		console.warn("[qvc] category lookup failed:", error.message);
		return slots;
	}
	const byId = new Map<string, string | null>();
	for (const row of (data ?? []) as { id: string; category: string | null }[]) {
		byId.set(row.id, row.category);
	}
	return slots.map((s) => {
		const fid = s.product_ids?.[0] ?? null;
		return { ...s, category: fid ? (byId.get(fid) ?? null) : null };
	});
}

export async function scrapeQVCForDate(date: Date): Promise<ScrapeResult> {
	const yyyymmdd = formatYYYYMMDD(date);
	const iso = formatISODate(date);
	const url = `${BASE_HOST}/content/programguide.qvc.${yyyymmdd}0000.html`;

	const fetched = await politeFetch(url);
	if (!fetched.ok || !fetched.body) {
		return {
			channel: "qvc",
			date: iso,
			slots: [],
			ok: false,
			error: fetched.error ?? "no body",
			health: computeHealth([], true),
		};
	}

	const slots = scrapeQVCFromHTML(fetched.body, iso);
	// Attach category from cached qvc_products but DO NOT drop non-whitelist slots.
	// Policy update (2026-05-17): collect everything, filter for whitelist in the UI
	// so that operators can inspect what competitors actually broadcast outside our
	// curated category set when needed.
	const enriched = await attachQVCCategories(slots);

	return {
		channel: "qvc",
		date: iso,
		slots: enriched,
		ok: true,
		health: computeHealth(enriched, true),
	};
}
