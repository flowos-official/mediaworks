/**
 * Post-Gemini source attribution — restore `pool_source` and (cautiously)
 * `discovered_product_id` on items returned by the curation LLM.
 *
 * Why this exists: Gemini was allowed by the curation prompt to rewrite
 * source URLs (strip tracking params, change formats). The previous inline
 * URL-only matcher in `discoverNewProducts` thus failed for most pool
 * items, mis-tagging them as `fresh_search` and dropping the
 * `discovered_product_id` linkage. This module makes the matching robust:
 *
 *   1. Exact URL match (normalized: lowercased host, no protocol, no www.,
 *      no query, no fragment, no trailing slash).
 *   2. Rakuten itemCode match (reuse `extractRakutenCode`) — Rakuten URLs
 *      have a stable `shop:itemId` identity that survives most rewrites.
 *   3. Generic host+path match (case-insensitive) for non-Rakuten domains
 *      where the path uniquely identifies the product.
 *   4. Name-only fallback — restores `pool_source` ONLY. Does NOT link
 *      `discovered_product_id`, because name alone is a weak identifier and
 *      a wrong ID would surface unrelated `c_package` / `tv_evidence` in
 *      the UI (false-positive guard called out in the subagent review).
 *
 * Anything that falls through to none of the above is tagged
 * `fresh_search` with no ID — i.e. Gemini either hallucinated or genuinely
 * pulled from the fresh-search pool.
 */

import { extractRakutenCode } from "@/lib/discovery/pool";

export interface AttributablePoolItem {
	name: string;
	source_url: string;
	pool_source: "discovery_pool" | "fresh_search" | "research";
	discovered_product_id?: string;
	// Real numeric price from the pool row — propagated to the output on an
	// ID-link match (same false-positive guard as tv_fit_score).
	price_jpy?: number;
	// Real candidate source from the underlying pool row (used to overwrite
	// any "rakuten|web" guess Gemini makes when it copies an item).
	source?: "rakuten" | "web" | "brave" | "tv_channel" | "other";
	tv_channel_source?: string | null;
	rakuten_cross_match?: {
		itemUrl: string;
		itemName: string;
		reviewCount: number;
		reviewAvg: number;
		priceJpy: number;
		similarityScore: number;
	} | null;
	// DB-side rule-based TV fit signal — Gemini emits a separate japan_fit_score,
	// so we overlay these from the pool row to expose both on the strategy card.
	tv_fit_score?: number;
	tv_fit_reason?: string;
	tv_evidence?: import("@/lib/discovery/types").TvEvidence | null;
	broadcast_tag?: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
	c_package?: Record<string, unknown> | null;
}

export interface AttributableGeminiItem {
	name: string;
	source_url: string;
	source?: string;
	tv_channel_source?: string | null;
}

export interface AttributionStats {
	url: number;
	itemCode: number;
	nameFallback: number;
	unmatched: number;
}

export interface AttributionResult<T extends AttributableGeminiItem> {
	enriched: Array<
		T & {
			pool_source: "discovery_pool" | "fresh_search" | "research";
			discovered_product_id?: string;
			price_jpy?: number;
			tv_fit_score?: number;
			tv_fit_reason?: string;
			tv_evidence?: import("@/lib/discovery/types").TvEvidence | null;
			broadcast_tag?: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
			c_package?: Record<string, unknown> | null;
		}
	>;
	stats: AttributionStats;
}

// ── URL normalization ─────────────────────────────────────────────────────

/**
 * Aggressive URL normalization for cross-matching:
 * - lowercase
 * - drop protocol
 * - drop leading "www."
 * - drop query string and fragment
 * - drop trailing slash
 *
 * Trade-off: this can collide URLs that legitimately differ only by
 * query parameters (e.g. variant selection). That risk is acceptable here
 * because (a) the pool already filters to specific product pages, and
 * (b) Rakuten itemCode is checked first when present.
 */
function normalizeUrl(u: string): string {
	if (!u) return "";
	let s = u.trim().toLowerCase();
	s = s.replace(/^https?:\/\//, "");
	s = s.replace(/^www\./, "");
	s = s.split("?")[0];
	s = s.split("#")[0];
	s = s.replace(/\/+$/, "");
	return s;
}

/**
 * Name normalization for last-resort matching. Strips whitespace and
 * common punctuation/brackets, lowercases, caps at 30 chars. Short enough
 * to survive minor truncation by Gemini, long enough to avoid colliding
 * unrelated products.
 */
function normalizeName(name: string): string {
	if (!name) return "";
	return name
		.toLowerCase()
		.replace(/[\s\-_/・、。（）()【】\[\]「」『』]+/g, "")
		.slice(0, 30);
}

// ── Main API ──────────────────────────────────────────────────────────────

export function attributeSource<T extends AttributableGeminiItem>(
	items: T[],
	pool: AttributablePoolItem[],
): AttributionResult<T> {
	const byUrl = new Map<string, AttributablePoolItem>();
	const byItemCode = new Map<string, AttributablePoolItem>();
	const byName = new Map<string, AttributablePoolItem>();

	for (const p of pool) {
		const u = normalizeUrl(p.source_url);
		if (u && !byUrl.has(u)) byUrl.set(u, p);
		const code = extractRakutenCode(p.source_url);
		if (code && !byItemCode.has(code)) byItemCode.set(code, p);
		const n = normalizeName(p.name);
		// Only register name → pool mapping if unique. Multiple pool items
		// sharing the same normalized name → don't trust any of them for
		// name fallback (ambiguous).
		if (n) {
			if (byName.has(n)) {
				byName.set(n, null as unknown as AttributablePoolItem); // sentinel: ambiguous
			} else {
				byName.set(n, p);
			}
		}
	}

	const stats: AttributionStats = { url: 0, itemCode: 0, nameFallback: 0, unmatched: 0 };

	function applyHit(item: T, hit: AttributablePoolItem, includeId: boolean) {
		// Overlay pool-derived source/tv_channel_source on top of the original
		// item so generic T fields (incl. required ones) survive the spread.
		// When the matched pool row carries no source we fall back to whatever
		// Gemini emitted so the field never becomes undefined.
		const merged = {
			...item,
			pool_source: hit.pool_source,
			discovered_product_id: includeId ? hit.discovered_product_id : undefined,
		} as T & {
			pool_source: "discovery_pool" | "fresh_search" | "research";
			discovered_product_id?: string;
			price_jpy?: number;
			tv_fit_score?: number;
			tv_fit_reason?: string;
			tv_evidence?: import("@/lib/discovery/types").TvEvidence | null;
			broadcast_tag?: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
			c_package?: Record<string, unknown> | null;
		};
		if (hit.source !== undefined) {
			(merged as { source?: string }).source = hit.source;
		}
		(merged as { tv_channel_source?: string | null }).tv_channel_source =
			hit.tv_channel_source ?? null;
		if (hit.rakuten_cross_match !== undefined) {
			(merged as { rakuten_cross_match?: unknown }).rakuten_cross_match =
				hit.rakuten_cross_match;
		}
		// Propagate DB-side TV signal fields. These are safe to overlay only when
		// we have a real ID-link (URL / itemCode match). Name-only fallback omits
		// them via includeId=false — same false-positive guard as discovered_product_id.
		if (includeId) {
			if (hit.price_jpy !== undefined) {
				merged.price_jpy = hit.price_jpy;
			}
			if (hit.tv_fit_score !== undefined) {
				merged.tv_fit_score = hit.tv_fit_score;
			}
			if (hit.tv_fit_reason !== undefined) {
				merged.tv_fit_reason = hit.tv_fit_reason;
			}
			if (hit.tv_evidence !== undefined) {
				merged.tv_evidence = hit.tv_evidence;
			}
			if (hit.broadcast_tag !== undefined) {
				merged.broadcast_tag = hit.broadcast_tag;
			}
			if (hit.c_package !== undefined) {
				merged.c_package = hit.c_package;
			}
		}
		return merged;
	}

	const enriched = items.map((item) => {
		// 1. Exact URL match (normalized)
		const u = normalizeUrl(item.source_url);
		const urlHit = u ? byUrl.get(u) : undefined;
		if (urlHit) {
			stats.url++;
			return applyHit(item, urlHit, true);
		}

		// 2. Rakuten itemCode rescue
		const code = extractRakutenCode(item.source_url);
		const codeHit = code ? byItemCode.get(code) : undefined;
		if (codeHit) {
			stats.itemCode++;
			return applyHit(item, codeHit, true);
		}

		// 3. Name-only fallback (restore pool_source, withhold ID)
		const n = normalizeName(item.name);
		const nameHit = n ? byName.get(n) : undefined;
		if (nameHit) {
			stats.nameFallback++;
			// Intentionally undefined ID — name alone is too weak to safely
			// link the original discovered_products row.
			return applyHit(item, nameHit, false);
		}

		// 4. No match → fresh_search; keep whatever source/channel Gemini guessed
		stats.unmatched++;
		return {
			...item,
			pool_source: "fresh_search" as const,
			discovered_product_id: undefined,
		};
	});

	return { enriched, stats };
}
