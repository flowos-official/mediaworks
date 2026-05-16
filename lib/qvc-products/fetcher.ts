import * as cheerio from "cheerio";
import { politeFetch } from "@/lib/broadcasts/fetch";

export interface QvcProductDetail {
	id: string;
	name: string | null;
	description: string | null;
	category: string | null;
	image_url: string | null;
	image_urls: string[];
	video_url: string | null;
	price_text: string | null;
	source_url: string;
}

const BASE = "https://qvc.jp";

function productUrl(id: string): string {
	return `${BASE}/product.${id}.html`;
}

function clean(s: string | undefined | null): string | null {
	if (!s) return null;
	const v = s.trim();
	return v.length === 0 ? null : v;
}

/**
 * Best-effort extraction of the product's top category from the page.
 * Sources, in order: (1) JSON-LD Product schema, (2) breadcrumb DOM.
 * Result is normalized to the top-level segment of the path (e.g.
 * "ビューティー/化粧水" → "ビューティー"). null when no signal found.
 */
function extractCategoryFromHTML($: cheerio.CheerioAPI): string | null {
	// 1) JSON-LD Product schema with a `category` field.
	const ldNodes = $('script[type="application/ld+json"]').toArray();
	for (const el of ldNodes) {
		const text = $(el).text();
		if (!text) continue;
		try {
			const parsed = JSON.parse(text);
			const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
			for (const item of items) {
				if (typeof item !== "object" || item === null) continue;
				const obj = item as Record<string, unknown>;
				if (obj["@type"] !== "Product") continue;
				const raw = obj.category;
				if (typeof raw !== "string") continue;
				const cleaned = clean(raw);
				if (!cleaned) continue;
				// "/" or " > "-separated paths → take the top-level segment.
				const top = cleaned.split(/[/>]/)[0]?.trim();
				if (top) return top;
			}
		} catch {
			// ignore parse failures; fall through to breadcrumb
		}
	}

	// 2) Breadcrumb fallback — first non-home crumb is usually the top category.
	const crumb = $(
		".breadcrumb a, nav[aria-label='breadcrumb'] a, ol.breadcrumb a",
	)
		.map((_, el) => clean($(el).text()))
		.toArray()
		.filter((s): s is string => s !== null);
	const interesting = crumb.filter(
		(c) => c !== "QVC.jp" && c !== "Home" && c !== "ホーム",
	);
	return interesting[0] ?? null;
}

/**
 * Pure parser — extract product detail from a qvc.jp/product.{id}.html body.
 * Server-rendered, so OG tags + a few inline meta are reliable.
 */
export function parseQvcProductHTML(html: string, id: string): QvcProductDetail {
	const $ = cheerio.load(html);

	const ogTitle = clean($('meta[property="og:title"]').attr("content"));
	// Strip trailing " - QVC.jp" if present
	const name = ogTitle ? ogTitle.replace(/\s*-\s*QVC\.jp\s*$/i, "") : null;

	const description = clean($('meta[property="og:description"]').attr("content"));
	const video_url = clean($('meta[property="og:video"]').attr("content"));

	const image_urls: string[] = [];
	$('meta[property="og:image"]').each((_, el) => {
		const v = clean($(el).attr("content"));
		if (v && !image_urls.includes(v)) image_urls.push(v);
	});
	const image_url = image_urls[0] ?? null;

	// Price: try og:price:amount → og:price:currency, else fall back to inline
	const ogPriceAmount = clean($('meta[property="og:price:amount"]').attr("content"));
	const ogPriceCurrency = clean($('meta[property="og:price:currency"]').attr("content"));
	let price_text: string | null = null;
	if (ogPriceAmount) {
		price_text = ogPriceCurrency
			? `${ogPriceCurrency} ${ogPriceAmount}`
			: ogPriceAmount;
	} else {
		// Inline price selectors (best-effort; structure changes per design refresh)
		const inline = clean(
			$(".price-sales, .price, .pdpPrice, [itemprop='price']").first().text(),
		);
		if (inline) price_text = inline;
	}

	const category = extractCategoryFromHTML($);

	return {
		id,
		name,
		description,
		category,
		image_url,
		image_urls,
		video_url,
		price_text,
		source_url: productUrl(id),
	};
}

export async function fetchQvcProduct(id: string): Promise<QvcProductDetail | null> {
	const fetched = await politeFetch(productUrl(id), { timeoutMs: 10_000 });
	if (!fetched.ok || !fetched.body) return null;
	try {
		return parseQvcProductHTML(fetched.body, id);
	} catch {
		return null;
	}
}
