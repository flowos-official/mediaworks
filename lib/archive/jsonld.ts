/**
 * JSON-LD extractor. Many product pages embed Schema.org structured data inside
 * `<script type="application/ld+json">` blocks — significantly richer and more
 * reliable than scraping HTML selectors. We pull out the typical fields
 * (Product, VideoObject) and also keep the raw blocks so future enrichment
 * can pull additional fields without re-fetching.
 */
import * as cheerio from "cheerio";

export interface JsonLdOffer {
	sku?: string;
	price?: string | number;
	priceCurrency?: string;
	availability?: string;
	url?: string;
	priceValidUntil?: string;
}

export interface ProductJsonLd {
	name?: string;
	description?: string;
	brand?: string;
	image?: string[];
	canonicalLink?: string;
	offers?: JsonLdOffer[];
}

export interface VideoJsonLd {
	name?: string;
	description?: string;
	thumbnailUrl?: string;
	contentUrl?: string;
	uploadDate?: string; // ISO datetime
}

export interface JsonLdResult {
	blocks: unknown[];     // raw parsed JSON-LD objects (one per <script> block, may be arrays inside)
	product: ProductJsonLd | null;
	video: VideoJsonLd | null;
}

function asArray(x: unknown): unknown[] {
	if (Array.isArray(x)) return x;
	if (x == null) return [];
	return [x];
}

function pickStr(x: unknown): string | undefined {
	return typeof x === "string" && x.length > 0 ? x : undefined;
}

function pickBrand(x: unknown): string | undefined {
	if (typeof x === "string") return x;
	if (x && typeof x === "object") {
		const o = x as Record<string, unknown>;
		if (typeof o.name === "string") return o.name;
	}
	return undefined;
}

function pickOffers(x: unknown): JsonLdOffer[] | undefined {
	const arr = asArray(x);
	if (arr.length === 0) return undefined;
	const out: JsonLdOffer[] = [];
	for (const o of arr) {
		if (!o || typeof o !== "object") continue;
		const r = o as Record<string, unknown>;
		out.push({
			sku: pickStr(r.sku),
			price: typeof r.price === "string" || typeof r.price === "number" ? r.price : undefined,
			priceCurrency: pickStr(r.priceCurrency),
			availability: pickStr(r.availability),
			url: pickStr(r.url),
			priceValidUntil: pickStr(r.priceValidUntil),
		});
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Walk all <script type="application/ld+json"> blocks in `html` and merge them
 * by @type. Returns merged Product + VideoObject (whichever is present), plus
 * the raw parsed blocks for archival.
 */
export function extractJsonLd(html: string): JsonLdResult {
	const $ = cheerio.load(html);
	const blocks: unknown[] = [];
	let product: ProductJsonLd | null = null;
	let video: VideoJsonLd | null = null;

	$('script[type="application/ld+json"]').each((_, el) => {
		const raw = $(el).text();
		if (!raw.trim()) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		blocks.push(parsed);

		const each = (item: unknown) => {
			if (!item || typeof item !== "object") return;
			const o = item as Record<string, unknown>;
			const type = pickStr(o["@type"]);
			if (type === "Product") {
				product = {
					name: pickStr(o.name),
					description: pickStr(o.description),
					brand: pickBrand(o.brand),
					image: asArray(o.image).filter((v) => typeof v === "string") as string[],
					canonicalLink: pickStr(o.canonicalLink),
					offers: pickOffers(o.offers),
				};
			} else if (type === "VideoObject") {
				const thumb = asArray(o.thumbnailUrl)[0];
				video = {
					name: pickStr(o.name),
					description: pickStr(o.description),
					thumbnailUrl: typeof thumb === "string" ? thumb : pickStr(o.thumbnailUrl),
					contentUrl: pickStr(o.contentURL) ?? pickStr(o.contentUrl),
					uploadDate: pickStr(o.uploadDate),
				};
			}
		};

		for (const item of asArray(parsed)) each(item);
	});

	return { blocks, product, video };
}
