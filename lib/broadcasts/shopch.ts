import * as cheerio from "cheerio";
import { politeFetch } from "./fetch";
import {
	buildProgramId,
	fetchShopChSlotMetadataBatch,
} from "./shopch-json";
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
 * Pure HTML parser — takes the raw HTML of shopch.jp/pc/tv/programlist?onAirDay=YYYYMMDD
 * and returns scraped slots for the given airDate only.
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

	const slots = scrapeShopChannelFromHTML(fetched.body, iso);

	// Fetch per-slot JSON metadata. `pgmcategory` becomes the slot category
	// (replaces the previous Gemini batch classifier as of 2026-05-19); the
	// same map also powers broadcast_products snapshot enrichment downstream
	// via shopchMetadataByProgramId.
	const programIds = slots.map((s) => buildProgramId(s.air_date, s.start_time));
	const shopchMetadataByProgramId = await fetchShopChSlotMetadataBatch(programIds, 3);
	const enriched = slots.map((s) => {
		const meta = shopchMetadataByProgramId.get(buildProgramId(s.air_date, s.start_time));
		return { ...s, category: meta?.category ?? null };
	});

	return {
		channel: "shopch",
		date: iso,
		slots: enriched,
		ok: true,
		health: computeHealth(enriched, true),
		shopchMetadataByProgramId,
	};
}
