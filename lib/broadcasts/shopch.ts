import * as cheerio from "cheerio";
import { politeFetch } from "./fetch";
import { fetchShopChSlotMetadataBatch } from "./shopch-json";
import { computeHealth, type ScrapeResult, type ScrapedSlot } from "./types";

const BASE_URL = "https://www.shopch.jp/pc/tv/programlist";

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
 * Parse time from data-program-id attribute (format: YYYYMMDDHHMMSS)
 * e.g. "20260511022925" → "02:29:25"
 */
function timeFromProgramId(programId: string): string | null {
	// programId is 14 chars: YYYYMMDDHHMMSS
	if (programId.length < 14) return null;
	const hh = programId.slice(8, 10);
	const mm = programId.slice(10, 12);
	const ss = programId.slice(12, 14);
	const h = parseInt(hh, 10);
	const m = parseInt(mm, 10);
	const s = parseInt(ss, 10);
	if (h > 23 || m > 59 || s > 59) return null;
	return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function absoluteUrl(href: string | undefined): string | null {
	if (!href) return null;
	if (href.startsWith("http")) return href;
	if (href.startsWith("//")) return `https:${href}`;
	if (href.startsWith("/")) return `https://www.shopch.jp${href}`;
	return null;
}

/**
 * Derive the lead-product detail URL from the slot's thumbnail image path.
 *
 * ShopCh image paths encode the 6-digit reqprno as the two path segments
 * directly under /img/prod/, e.g.
 *   /img/prod/820/002/82000201M.jpg → reqprno=820002
 *
 * The canonical product detail page is then:
 *   https://www.shopch.jp/pc/product/proddetail?reqprno=820002
 *
 * Returns null when the src does not match (e.g. /navigator/ placeholders).
 */
export function deriveShopChProductUrl(imgSrc: string | undefined | null): string | null {
	if (!imgSrc) return null;
	const m = imgSrc.match(/\/img\/prod\/(\d{3})\/(\d{3})\//);
	if (!m) return null;
	return `https://www.shopch.jp/pc/product/proddetail?reqprno=${m[1]}${m[2]}`;
}

/**
 * Extract the day's program IDs (YYYYMMDDHHMMSS) from the programlist HTML.
 *
 * Why this over `scrapeShopChannelFromHTML`: as of ~2026-05-28 the programlist
 * page renders article *inner* markup (title/product/cast) only for the current
 * JST day — past/future days arrive as empty client-side template placeholders,
 * so the cheerio parser yields ~0 slots for any non-today request (which the
 * "scrape yesterday" cron always hits). The `data-program-id` attributes,
 * however, are present in the static HTML for the whole served window, and the
 * per-slot JSON endpoint (`/json/programprodlist2/{id}.json`) returns complete
 * data for those IDs on any day — so we enumerate IDs here and hydrate via JSON.
 */
export function extractShopChProgramIds(html: string, airDate: string): string[] {
	const yyyymmdd = airDate.replace(/-/g, "");
	const ids = new Set<string>();
	for (const m of html.matchAll(/data-program-id="(\d{14})"/g)) {
		if (m[1].startsWith(yyyymmdd)) ids.add(m[1]);
	}
	return [...ids].sort();
}

/**
 * Legacy pure HTML parser — takes the raw HTML of
 * shopch.jp/pc/tv/programlist?onAirDay=YYYYMMDD and returns scraped slots for
 * the given airDate only. Retained for the fixture-based parser test; the live
 * path (`scrapeShopChannelForDate`) is JSON-driven (see `extractShopChProgramIds`)
 * because this parser only works for the current-day request.
 *
 * Structure observed in fixture:
 *   article.pg-program-item[data-program-id="YYYYMMDDHHMMSS"]
 *     .pg-item-time          → display time (e.g. "0:00", "2:29") — NOT used (imprecise)
 *     .pg-item-hd .pg-item-sub → program/show name (program_title)
 *     figure.pg-item-figure
 *       img[src]             → thumbnail
 *       .pg-item-name        → product/item name (description)
 *       .pg-item-attr-row    → rows of キャスト/ゲスト labels + values
 */
export function scrapeShopChannelFromHTML(
	html: string,
	airDate: string,
): ScrapedSlot[] {
	const $ = cheerio.load(html);
	const slots: ScrapedSlot[] = [];

	// Derive the YYYYMMDD prefix to filter this day's articles
	const yyyymmdd = airDate.replace(/-/g, "");
	const sourceUrl = `${BASE_URL}?onAirDay=${yyyymmdd}`;

	$("article.pg-program-item").each((_, el) => {
		const $el = $(el);
		const programId = $el.attr("data-program-id") ?? "";

		// Only parse slots for the requested date
		if (!programId.startsWith(yyyymmdd)) return;

		const startTime = timeFromProgramId(programId);
		if (!startTime) return;

		// Program/show title
		const programTitle = $el.find(".pg-item-sub").first().text().trim();
		if (!programTitle) return;

		// Description: product/item name inside the figure overlay
		const description = $el.find(".pg-item-name").first().text().trim() || null;

		// Thumbnail
		const rawImgSrc = $el.find("figure.pg-item-figure img").first().attr("src");
		const thumbnailUrl = absoluteUrl(rawImgSrc);

		// Cast: find キャスト row, grab the second cell text
		let presenter: string | null = null;
		$el.find(".pg-item-attr-row").each((_, row) => {
			const $row = $(row);
			const cells = $row.find(".pg-item-attr-cell");
			const label = cells.first().text().trim();
			if (label.includes("キャスト")) {
				const value = cells.eq(1).text().trim();
				if (value) {
					presenter = value;
				}
			}
		});

		// Source URL: derive product detail URL from the thumbnail image path.
		// The article only contains presenter-profile <a> tags (js-unclickable),
		// so we must NOT use those — they'd land on the host's profile page.
		const productUrl = deriveShopChProductUrl(rawImgSrc);

		slots.push({
			channel: "shopch",
			air_date: airDate,
			start_time: startTime,
			program_title: programTitle,
			presenter,
			description,
			thumbnail_url: thumbnailUrl,
			source_url: productUrl ?? sourceUrl,
			product_ids: null,
			category: null, // attached later in scrapeShopChannelForDate from JSON pgmcategory
		});
	});

	slots.sort((a, b) => a.start_time.localeCompare(b.start_time));
	return slots;
}

export async function scrapeShopChannelForDate(date: Date): Promise<ScrapeResult> {
	const yyyymmdd = formatYYYYMMDD(date);
	const iso = formatISODate(date);
	const url = `${BASE_URL}?onAirDay=${yyyymmdd}`;

	const fetched = await politeFetch(url);
	if (!fetched.ok || !fetched.body) {
		return {
			channel: "shopch",
			date: iso,
			slots: [],
			ok: false,
			error: fetched.error ?? "no body",
			health: computeHealth([], true),
		};
	}

	// Under load the site returns a 200 "アクセスが集中" busy page instead of the
	// real programlist. Treat it as a retryable error rather than a genuine empty
	// schedule — otherwise the cron would persist 0 slots and trip the
	// markup-change warning on a transient rate limit.
	if (fetched.body.includes("アクセスが集中")) {
		return {
			channel: "shopch",
			date: iso,
			slots: [],
			ok: false,
			error: "shopch busy page (rate limited)",
			health: computeHealth([], true),
		};
	}

	// Enumerate the day's program IDs from the static HTML, then hydrate each
	// from the per-slot JSON endpoint (title/category/brand/products/video). The
	// JSON is the single source of truth — it returns complete data for past,
	// current, and future days alike, unlike the page's article inner-markup.
	const programIds = extractShopChProgramIds(fetched.body, iso);
	const shopchMetadataByProgramId = await fetchShopChSlotMetadataBatch(programIds, 3);

	const slots: ScrapedSlot[] = [];
	for (const programId of programIds) {
		const meta = shopchMetadataByProgramId.get(programId);
		if (!meta) continue;
		const startTime = timeFromProgramId(programId);
		if (!startTime) continue;
		// Skip empty placeholders (no title ⇒ no real program data).
		if (!meta.programTitle) continue;

		const leadProductId = meta.productIds[0] ?? null;
		slots.push({
			channel: "shopch",
			air_date: iso,
			start_time: startTime,
			program_title: meta.programTitle,
			presenter: meta.presenter,
			description: meta.products[0]?.name ?? null,
			thumbnail_url: meta.thumbnailUrl,
			source_url: leadProductId
				? `https://www.shopch.jp/pc/product/proddetail?reqprno=${leadProductId}`
				: url,
			product_ids: null,
			category: meta.category,
		});
	}

	slots.sort((a, b) => a.start_time.localeCompare(b.start_time));

	return {
		channel: "shopch",
		date: iso,
		slots,
		ok: true,
		health: computeHealth(slots, true),
		shopchMetadataByProgramId,
	};
}
