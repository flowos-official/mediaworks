import * as cheerio from "cheerio";
import { politeFetch } from "../fetch";
import type { ImageExtractor } from "./types";

/**
 * Pure-function variant: parse og:image from an HTML string.
 * Exposed for fixture-based tests; not used by the live extractor below.
 */
export function parseOgImageFromHtml(html: string, sourceUrl: string): string | null {
	try {
		const $ = cheerio.load(html);
		const og = $('meta[property="og:image"]').attr("content")?.trim();
		if (!og) return null;
		// Resolve relative URLs (defensive — most sites give absolute, but not all)
		return new URL(og, sourceUrl).toString();
	} catch {
		return null;
	}
}

/**
 * Live extractor: fetch the source URL and extract og:image.
 * Returns null on any failure (HTTP error, missing meta, parse failure).
 *
 * Used by junsanpo, tbs, dinos, senobura, uranoura — all sites that
 * render product detail pages with `<meta property="og:image">` in
 * server-rendered HTML.
 */
export const ogImageExtractor: ImageExtractor = {
	async extract(sourceUrl: string): Promise<string | null> {
		const r = await politeFetch(sourceUrl);
		if (!r.ok || !r.body) return null;
		return parseOgImageFromHtml(r.body, sourceUrl);
	},
};
