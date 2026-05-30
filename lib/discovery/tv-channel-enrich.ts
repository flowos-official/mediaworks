import * as cheerio from "cheerio";

export interface EnrichedMetadata {
	thumbnail_url: string | null;
	price_jpy: number | null;
	category: string | null;
	description: string | null;
}

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseJpyFromText(s: string | null | undefined): number | null {
	if (!s) return null;
	// Match the FIRST well-formed number (comma-grouped or a plain run), so a
	// glued price range like "9,000〜15,000" / "9,00015,000" yields 9000 — not the
	// concatenation 900015000 the old greedy [0-9,]{2,} produced. Upper bound
	// rejects any residual concatenation artifact.
	const m = s.match(/(\d{1,3}(?:,\d{3})+|\d{3,})\s*円?/);
	if (!m) return null;
	const n = parseInt(m[1].replace(/,/g, ""), 10);
	return Number.isFinite(n) && n > 0 && n < 10_000_000 ? n : null;
}

function pickAbsoluteUrl(
	candidate: string | null | undefined,
	base: string,
): string | null {
	if (!candidate) return null;
	try {
		return new URL(candidate, base).toString();
	} catch {
		return null;
	}
}

interface JsonLdObj {
	"@type"?: string | string[];
	name?: string;
	image?: string | string[] | { url?: string };
	offers?:
		| { price?: string | number; priceCurrency?: string }
		| Array<{ price?: string | number; priceCurrency?: string }>;
	category?: string;
	description?: string;
}

function unwrap(v: unknown): JsonLdObj[] {
	if (!v) return [];
	if (Array.isArray(v)) return v.flatMap(unwrap);
	if (typeof v === "object" && v !== null) {
		const obj = v as Record<string, unknown>;
		const graph = obj["@graph"];
		if (Array.isArray(graph)) return graph.flatMap(unwrap);
		return [obj as JsonLdObj];
	}
	return [];
}

function isProduct(t: string | string[] | undefined): boolean {
	if (!t) return false;
	const arr = Array.isArray(t) ? t : [t];
	return arr.some((s) => s === "Product" || s === "schema:Product");
}

function pickImage(img: JsonLdObj["image"]): string | null {
	if (!img) return null;
	if (typeof img === "string") return img;
	if (Array.isArray(img)) return typeof img[0] === "string" ? img[0] : null;
	if (typeof img === "object" && "url" in img && typeof img.url === "string") {
		return img.url;
	}
	return null;
}

function pickPrice(offers: JsonLdObj["offers"]): number | null {
	if (!offers) return null;
	const arr = Array.isArray(offers) ? offers : [offers];
	for (const o of arr) {
		if (o?.price !== undefined) {
			const n =
				typeof o.price === "number"
					? o.price
					: parseFloat(String(o.price).replace(/,/g, ""));
			if (Number.isFinite(n) && n > 0) return Math.round(n);
		}
	}
	return null;
}

export function parseMetadata(html: string, baseUrl: string): EnrichedMetadata {
	const $ = cheerio.load(html);

	const acc: {
		thumb: string | null;
		price: number | null;
		category: string | null;
		description: string | null;
	} = { thumb: null, price: null, category: null, description: null };

	$("script[type='application/ld+json']").each((_, el) => {
		const text = $(el).contents().text();
		if (!text) return;
		try {
			const parsed: unknown = JSON.parse(text);
			for (const obj of unwrap(parsed)) {
				if (!isProduct(obj["@type"])) continue;
				if (!acc.thumb) acc.thumb = pickImage(obj.image);
				if (!acc.price) acc.price = pickPrice(obj.offers);
				if (!acc.category && obj.category) acc.category = obj.category;
				if (!acc.description && obj.description) acc.description = obj.description;
			}
		} catch {
			/* ignore */
		}
	});

	let thumb = acc.thumb;
	let price = acc.price;
	const category = acc.category;
	let description = acc.description;

	if (!thumb) {
		thumb =
			$("meta[property='og:image']").attr("content") ??
			$("meta[name='twitter:image']").attr("content") ??
			null;
	}
	if (!price) {
		const priceAmount =
			$("meta[property='product:price:amount']").attr("content") ??
			$("meta[property='og:price:amount']").attr("content");
		if (priceAmount) {
			const n = parseFloat(priceAmount.replace(/,/g, ""));
			if (Number.isFinite(n) && n > 0) price = Math.round(n);
		}
	}
	if (!price) {
		const candidates = [
			$("[itemprop='price']").attr("content"),
			$(".price").first().text(),
			$("[class*='price' i]").first().text(),
		];
		for (const c of candidates) {
			const n = parseJpyFromText(c);
			if (n) {
				price = n;
				break;
			}
		}
	}
	if (!description) {
		description =
			$("meta[property='og:description']").attr("content") ??
			$("meta[name='description']").attr("content") ??
			null;
	}

	return {
		thumbnail_url: pickAbsoluteUrl(thumb, baseUrl),
		price_jpy: price,
		category: category ? category.slice(0, 200) : null,
		description: description ? description.slice(0, 500) : null,
	};
}

export async function fetchAndParseMetadata(
	url: string,
	timeoutMs = 15000,
): Promise<EnrichedMetadata | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": "ja,en;q=0.8",
			},
		});
		if (!res.ok) return null;
		const ct = res.headers.get("content-type") ?? "";
		if (!ct.includes("html")) return null;
		const html = await res.text();
		return parseMetadata(html, url);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
