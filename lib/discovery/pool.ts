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
import { getServiceClient } from "@/lib/supabase";
import { broadcastsChannelToSlug } from "./tv-channels";
import type { CategoryPlan, PoolItem, Track } from "./types";

const RAKUTEN_THROTTLE_MS = 1100;
const RAKUTEN_PER_KEYWORD = 10;
const BRAVE_PER_KEYWORD = 5;
const TV_CHANNEL_BROADCAST_WINDOW_DAYS = Number(
	process.env.TV_CHANNEL_BROADCAST_WINDOW_DAYS ?? 30,
);

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

/**
 * Normalize a description for comparison. Original strings are preserved
 * separately for display.
 */
function normalizeDescription(s: string): string {
	return s
		.normalize("NFKC")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** Substring match against the normalized description. Seeds are matched as
 *  given (assume seedKeyword strings are short and already in canonical form). */
function matchAnySeed(normalized: string, seeds: readonly string[]): boolean {
	for (const s of seeds) {
		if (!s) continue;
		if (normalized.includes(s.toLowerCase())) return true;
	}
	return false;
}

interface BroadcastRow {
	channel: "shopch" | "qvc";
	description: string;
	thumbnail_url: string | null;
	source_url: string;
	air_date: string; // YYYY-MM-DD
}

/**
 * Group broadcast rows by normalized description.
 * - tvChannelMatches: all channels that aired the product, alphabetical.
 * - thumbnail/url: most recent slot wins.
 * - name: longest original description seen (preserves type-numbers / full-width).
 */
function groupBroadcastRows(rows: readonly BroadcastRow[]): PoolItem[] {
	const groups = new Map<
		string,
		{
			displayName: string;
			channels: Set<string>;
			latest: { airDate: string; thumb: string | null; url: string };
		}
	>();

	for (const row of rows) {
		if (!row.description) continue;
		const key = normalizeDescription(row.description);
		if (!key) continue;
		const slug = broadcastsChannelToSlug(row.channel);
		const existing = groups.get(key);
		if (!existing) {
			groups.set(key, {
				displayName: row.description,
				channels: new Set([slug]),
				latest: { airDate: row.air_date, thumb: row.thumbnail_url, url: row.source_url },
			});
			continue;
		}
		existing.channels.add(slug);
		// Keep longest original description as display.
		if (row.description.length > existing.displayName.length) {
			existing.displayName = row.description;
		}
		// Most recent slot's thumbnail/url.
		if (row.air_date > existing.latest.airDate) {
			existing.latest = {
				airDate: row.air_date,
				thumb: row.thumbnail_url,
				url: row.source_url,
			};
		}
	}

	const items: PoolItem[] = [];
	for (const [, group] of groups) {
		const channelList = Array.from(group.channels).sort();
		items.push({
			name: group.displayName,
			productUrl: group.latest.url,
			thumbnailUrl: group.latest.thumb ?? undefined,
			source: "tv_channel",
			seedKeyword: "", // filled in by caller after seed match
			track: "tv_proven",
			tvChannel: channelList[0],
			tvChannelMatches: channelList,
		});
	}
	return items;
}

/**
 * Pass C: read recent broadcast slots, group by normalized description,
 * filter to descriptions matching any seed keyword. Returns one PoolItem
 * per surviving group. Fail-open on DB error.
 */
async function fetchTvChannelFromBroadcasts(
	plan: CategoryPlan,
	windowDays = TV_CHANNEL_BROADCAST_WINDOW_DAYS,
): Promise<PoolItem[]> {
	const sb = getServiceClient();
	const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000)
		.toISOString()
		.slice(0, 10);
	const { data, error } = await sb
		.from("broadcasts")
		.select("channel, description, thumbnail_url, source_url, air_date")
		.gte("air_date", since)
		.not("description", "is", null);

	if (error) {
		console.warn(`[pool] broadcasts SELECT failed: ${error.message}`);
		return [];
	}
	const rows = (data ?? []) as BroadcastRow[];
	const grouped = groupBroadcastRows(rows);

	const seeds = [...plan.tv_proven, ...plan.exploration]
		.map((s) => s.toLowerCase().trim())
		.filter(Boolean);

	const result: PoolItem[] = [];
	for (const item of grouped) {
		const normalized = normalizeDescription(item.name);
		const matchedSeed = seeds.find((s) => normalized.includes(s));
		if (!matchedSeed) continue;
		result.push({
			...item,
			seedKeyword: matchedSeed,
			track: plan.tv_proven.map((s) => s.toLowerCase()).includes(matchedSeed)
				? "tv_proven"
				: "exploration",
		});
	}
	return result;
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
		category: it.genreName || undefined,
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
		return res.items.map((it) =>
			rakutenItemToPoolItem(
				{
					...it,
					genreName: it.genreName || res.genreName || undefined,
				},
				keyword,
				track,
			),
		);
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
	normalizeDescription,
	matchAnySeed,
	groupBroadcastRows,
	fetchTvChannelFromBroadcasts,
};
