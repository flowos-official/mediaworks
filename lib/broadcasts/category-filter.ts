/**
 * Phase 1-C: per-channel category whitelist loader + matcher.
 *
 * Source of truth: `channel_categories` table. The cron paths load the
 * whitelist on each crawl run; the in-process cache makes a single DB
 * call regardless of slot count.
 */
import { getServiceClient } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Normalize a category string: NFKC + strip whitespace so 全角/半角 mismatches
 * between site HTML and seed text don't cause false-negatives.
 */
export function normalizeCategory(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const norm = raw.normalize("NFKC").replace(/\s+/g, "").trim();
	return norm.length > 0 ? norm : null;
}

let cache:
	| { byChannel: Map<string, Set<string>>; loadedAt: number }
	| null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Load the whitelist (channel → Set<normalized category>) with a 5-minute
 * in-process cache. Pass `force=true` to bypass the cache (e.g. after an
 * admin edit, when one is wired up).
 */
export async function loadWhitelist(
	force = false,
	signal?: AbortSignal,
): Promise<Map<string, Set<string>>> {
	return loadWhitelistWithClient(getServiceClient(), force, signal);
}

/** Injectable production query used by cron/helper tests without live access. */
export async function loadWhitelistWithClient(
	sb: SupabaseClient,
	force = false,
	signal?: AbortSignal,
): Promise<Map<string, Set<string>>> {
	if (!force && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
		return cache.byChannel;
	}
	let query = sb
		.from("channel_categories")
		.select("channel, category")
		.eq("is_allowed", true);
	if (signal) query = query.abortSignal(signal);
	const { data, error } = await query;

	if (error || !data) {
		if (signal?.aborted) {
			throw signal.reason ?? new Error("category whitelist load aborted");
		}
		throw new Error(`category whitelist load failed: ${error?.message ?? "query returned no data"}`);
	}
	const byChannel = new Map<string, Set<string>>();
	for (const row of data as { channel: string; category: string }[]) {
		const set = byChannel.get(row.channel) ?? new Set<string>();
		const norm = normalizeCategory(row.category);
		if (norm) set.add(norm);
		byChannel.set(row.channel, set);
	}
	cache = { byChannel, loadedAt: Date.now() };
	return byChannel;
}

/** Returns true iff `category` (after normalization) is in the whitelist for `channel`. */
export function isAllowed(
	byChannel: Map<string, Set<string>>,
	channel: string,
	category: string | null,
): boolean {
	const norm = normalizeCategory(category);
	if (!norm) return false;
	const set = byChannel.get(channel);
	if (!set) return false;
	return set.has(norm);
}

export const __test = {
	resetCache: () => {
		cache = null;
	},
};
