import * as cheerio from "cheerio";
import { politeFetch } from "@/lib/broadcasts/fetch";

export interface QvcProductDetail {
	id: string;
	name: string | null;
	description: string | null;
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

	return {
		id,
		name,
		description,
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
