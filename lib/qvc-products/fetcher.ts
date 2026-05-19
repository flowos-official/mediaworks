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
 *
 * Breadcrumb shape on qvc.jp/product.{id}.html:
 *   [home-icon link "QVCホームページ … icon …"] > [top-cat] > [sub] > 商品詳細ページ
 * The home link's anchor text is the localized accessibility label which
 * concatenates "QVCホームページ" with the icon alt "An icon that looks like
 * a house.". Both shapes are filtered.
 */
const BREADCRUMB_SKIP_PATTERNS = [
	/QVC\.jp/i,
	/QVCホームページ/,
	/^Home$/i,
	/^ホーム$/, // exact match only — substring would eat valid "ホーム" category
	/An icon that looks like a house/i,
	/商品詳細ページ/,
];

function isHomeOrPageCrumb(text: string): boolean {
	return BREADCRUMB_SKIP_PATTERNS.some((re) => re.test(text));
}

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

	// 2) Breadcrumb fallback. Walk only DIRECT links (not nested span/li
	// duplicates) and skip the home/page crumbs to get the first real
	// category. Using `> a` would miss QVC's actual nesting, so we accept
	// duplicates and dedupe via Set.
	const seen = new Set<string>();
	const ordered: string[] = [];
	$(".breadcrumb a, nav[aria-label='breadcrumb'] a, ol.breadcrumb a").each(
		(_, el) => {
			const raw = clean($(el).text());
			if (!raw) return;
			// Collapse internal whitespace (newlines / tabs from icon labels)
			// so substring filters still apply.
			const collapsed = raw.replace(/\s+/g, " ").trim();
			if (!collapsed || seen.has(collapsed)) return;
			seen.add(collapsed);
			ordered.push(collapsed);
		},
	);
	for (const c of ordered) {
		if (!isHomeOrPageCrumb(c)) return c;
	}
	return null;
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
