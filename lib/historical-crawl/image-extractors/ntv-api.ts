import { politeFetch } from "../fetch";
import type { ImageExtractor } from "./types";

const API_BASE = "https://shop.ntv.co.jp/api/v1/item/detail-list/json";

export interface NtvApiResponse {
	itemListInfoXML?: {
		rcd?: number;
		count?: number;
		itL?: Array<{
			itD?: {
				item?: {
					mainImgList?: Array<{
						imgInfo?: { path?: string };
					}>;
				};
			};
		}>;
	};
}

/**
 * Extract the `bics` (ntv-internal item id) from a source URL.
 * The ntv parser persists URLs like https://shop.ntv.co.jp/item/{bics}[?...].
 * Returns null when the URL doesn't match the expected /item/{id} shape.
 */
export function extractNtvBicsFromSourceUrl(sourceUrl: string): string | null {
	const m = sourceUrl.match(/\/item\/([a-zA-Z0-9]+)/);
	return m ? m[1] : null;
}

/**
 * Navigate the deeply-nested response to find the first product's main image.
 * Pure function; null on any missing path.
 */
export function parseNtvApiImage(body: NtvApiResponse): string | null {
	const path =
		body?.itemListInfoXML?.itL?.[0]?.itD?.item?.mainImgList?.[0]?.imgInfo?.path;
	return typeof path === "string" && path.length > 0 ? path : null;
}

/**
 * Live extractor: derive bics from source URL, fetch the public detail API,
 * extract image. Returns null on any failure.
 */
export const ntvApiExtractor: ImageExtractor = {
	async extract(sourceUrl: string): Promise<string | null> {
		const bics = extractNtvBicsFromSourceUrl(sourceUrl);
		if (!bics) return null;
		const apiUrl = `${API_BASE}?bics=${encodeURIComponent(bics)}&ptn=p0`;
		const r = await politeFetch(apiUrl, {
			headers: { Accept: "application/json, text/plain, */*" },
		});
		if (!r.ok || !r.body) return null;
		try {
			const body = JSON.parse(r.body) as NtvApiResponse;
			return parseNtvApiImage(body);
		} catch {
			return null;
		}
	},
};
