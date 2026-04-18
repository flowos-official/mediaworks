/**
 * Pool builder — fetches Rakuten + Brave results for a category plan.
 * Ref: spec §4.2 단계 3.
 *
 * Rakuten: sequential (1s throttle per Rakuten rate-limit rules).
 * Brave: parallel (separate rate budget).
 */

import { braveSearchItems } from "@/lib/brave";
import {
	rakutenItemSearch,
	rakutenRankingSearch,
	type RakutenItem,
} from "@/lib/rakuten";
import type { CategoryPlan, PoolItem, Track } from "./types";

const RAKUTEN_THROTTLE_MS = 1100;
const RAKUTEN_PER_KEYWORD = 10;
const BRAVE_PER_KEYWORD = 5;

/**
 * Normalize URL for dedup: force https, strip trailing slash, lowercase hostname.
 * Does NOT modify path casing (paths are case-sensitive).
 */
function normalizeUrlForDedup(url: string): string {
	try {
		const u = new URL(url);
		u.protocol = "https:";
		u.hostname = u.hostname.toLowerCase();
		let href = u.toString();
		if (href.endsWith("/") && u.pathname !== "/") {
			href = href.slice(0, -1);
		}
		return href;
	} catch {
		// malformed URL — return as-is, let caller dedup by raw string
		return url;
	}
}

/**
 * Extract Rakuten item code (shopCode:itemCode) from an item URL.
 * Pattern: https://item.rakuten.co.jp/<shop>/<item>/
 */
export function extractRakutenCode(url: string): string | undefined {
	const m = url.match(/item\.rakuten\.co\.jp\/([^/]+)\/([^/?#]+)/);
	return m ? `${m[1]}:${m[2]}` : undefined;
}

function rakutenItemToPoolItem(
	it: RakutenItem,
	seed: string,
	track: Track,
): PoolItem {
	return {
		name: it.itemName,
		productUrl: it.itemUrl,
		thumbnailUrl: it.imageUrl,
		priceJpy: it.itemPrice || undefined,
		reviewCount: it.reviewCount,
		reviewAvg: it.reviewAverage || undefined,
		sellerName: it.shopName || undefined,
		source: "rakuten",
		rakutenItemCode: extractRakutenCode(it.itemUrl),
		seedKeyword: seed,
		track,
	};
}

async function fetchRakutenForKeyword(
	keyword: string,
	track: Track,
): Promise<PoolItem[]> {
	try {
		let res = await rakutenItemSearch(
			keyword,
			"-reviewCount",
			RAKUTEN_PER_KEYWORD,
		);
		if (res.items.length === 0) {
			res = await rakutenRankingSearch(keyword, undefined, RAKUTEN_PER_KEYWORD);
		}
		return res.items.map((it) => rakutenItemToPoolItem(it, keyword, track));
	} catch (err) {
		console.warn(
			`[pool] rakuten "${keyword}" failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

async function fetchBraveForKeyword(
	keyword: string,
	track: Track,
): Promise<PoolItem[]> {
	const query = `${keyword} 通販 おすすめ 楽天 Amazon`;
	try {
		const results = await braveSearchItems(query, 10);
		return results.slice(0, BRAVE_PER_KEYWORD).map((r) => ({
			name: r.title,
			productUrl: r.url,
			source: "brave" as const,
			seedKeyword: keyword,
			track,
		}));
	} catch (err) {
		console.warn(
			`[pool] brave "${keyword}" failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

/**
 * Build the candidate pool for a category plan.
 * Returns unique items (by URL) across Rakuten + Brave sources.
 */
export async function buildPool(plan: CategoryPlan): Promise<PoolItem[]> {
	const tvKws = plan.tv_proven.map((kw) => ({ kw, track: "tv_proven" as Track }));
	const expKws = plan.exploration.map((kw) => ({
		kw,
		track: "exploration" as Track,
	}));
	const allKws = [...tvKws, ...expKws];

	const pool: PoolItem[] = [];
	const seenUrls = new Set<string>();

	// Rakuten — sequential with throttle
	for (const { kw, track } of allKws) {
		const items = await fetchRakutenForKeyword(kw, track);
		for (const it of items) {
			const key = normalizeUrlForDedup(it.productUrl);
			if (seenUrls.has(key)) continue;
			seenUrls.add(key);
			pool.push(it);
		}
		await new Promise((r) => setTimeout(r, RAKUTEN_THROTTLE_MS));
	}

	// Brave — parallel
	const braveBatches = await Promise.allSettled(
		allKws.map(({ kw, track }) => fetchBraveForKeyword(kw, track)),
	);
	for (const batch of braveBatches) {
		if (batch.status !== "fulfilled") continue;
		for (const it of batch.value) {
			const key = normalizeUrlForDedup(it.productUrl);
			if (seenUrls.has(key)) continue;
			seenUrls.add(key);
			pool.push(it);
		}
	}

	return pool;
}

export const __test = {
	RAKUTEN_THROTTLE_MS,
	RAKUTEN_PER_KEYWORD,
	BRAVE_PER_KEYWORD,
};
