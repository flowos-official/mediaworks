/**
 * Fast preview search — runs ONE Rakuten keyword search so the streaming
 * preview surfaces the actually-searched product (~1s) instead of the
 * generic pool top. Display-only: results are NOT persisted (the final
 * curated discoverNewProducts owns persistence). Independent of the
 * PHASE_0_5_SEARCH_INTENT_ENABLED flag — falls back to category_hints[0],
 * which the legacy goal prompt still populates when the flag is off.
 *
 * No `import "server-only"` — this module is imported directly by
 * scripts/test-fast-preview.ts under tsx (see CLAUDE.md).
 */
import { rakutenItemSearch, rakutenRankingSearch, type RakutenItem } from "@/lib/rakuten";
import type { DiscoverIntent } from "@/lib/strategy/discover-intent";
import type { DiscoveredProduct } from "@/lib/md-strategy";
import { parsePriceRange } from "@/lib/strategy/parse-price-range";

const PREVIEW_TARGET = 15;
const PREVIEW_FETCH = 12;

/** specific_keyword.normalized (flag on) ?? first non-empty category_hint (flag off) ?? null. */
export function derivePreviewKeyword(intent: DiscoverIntent | null | undefined): string | null {
	if (!intent) return null;
	const sk = intent.specific_keyword?.normalized?.trim();
	if (sk) return sk;
	const cat = intent.category_hints?.find((c) => c.trim().length > 0)?.trim();
	return cat && cat.length > 0 ? cat : null;
}

// price parsing shared with the final discovery via parse-price-range.ts

function formatPriceJpy(price: number): string {
	if (!Number.isFinite(price) || price <= 0) return "価格未取得";
	return `¥${price.toLocaleString("ja-JP")}`;
}

function rakutenItemToDiscoveredProduct(item: RakutenItem): DiscoveredProduct {
	const popularity =
		item.reviewCount && item.reviewAverage
			? `レビュー${item.reviewCount}件・平均★${item.reviewAverage.toFixed(1)}`
			: "—";
	// Honest social-proof proxy (NOT a fabricated TV-fit): review avg → 0-100.
	const reviewProxy = Math.min(100, Math.max(0, Math.round((item.reviewAverage ?? 0) * 20)));
	return {
		name: item.itemName.slice(0, 80),
		reason: "検索結果（暫定） — 戦略分析完了後に精緻化されます",
		japan_fit_score: reviewProxy,
		estimated_demand: item.reviewCount > 0 ? `レビュー${item.reviewCount}件` : "—",
		supply_source: item.shopName || "楽天",
		estimated_price_jpy: formatPriceJpy(item.itemPrice),
		source: "rakuten",
		source_url: item.itemUrl,
		signal_basis: `楽天検索（暫定） ${popularity}`,
		japan_market_fit: {
			popularity_evidence: popularity,
			trend_context: "検索結果（暫定）",
			why_japan_now: "暫定先行表示 — 戦略分析完了後に精緻化されます",
		},
		pool_source: "fresh_search",
	};
}

export interface FastPreviewSearchInput {
	intent?: DiscoverIntent;
	priceRange?: string;
}

/** Run ONE Rakuten keyword search and map to DiscoveredProduct[]. [] on no-keyword / failure / empty. */
export async function runFastPreviewSearch(
	input: FastPreviewSearchInput,
): Promise<DiscoveredProduct[]> {
	const keyword = derivePreviewKeyword(input.intent);
	if (!keyword) return [];
	try {
		let res = await rakutenItemSearch(keyword, "-reviewCount", PREVIEW_FETCH);
		if (res.items.length === 0) res = await rakutenRankingSearch(keyword);
		const priceRange = input.priceRange ? parsePriceRange(input.priceRange) : null;
		const seen = new Set<string>();
		const products: DiscoveredProduct[] = [];
		for (const item of res.items) {
			if (!item.itemUrl || !item.itemName || seen.has(item.itemUrl)) continue;
			if (
				priceRange &&
				item.itemPrice > 0 &&
				(item.itemPrice < priceRange.min || item.itemPrice > priceRange.max)
			) {
				continue;
			}
			seen.add(item.itemUrl);
			products.push(rakutenItemToDiscoveredProduct(item));
			if (products.length >= PREVIEW_TARGET) break;
		}
		return products;
	} catch (err) {
		console.warn(`[fast-preview] search failed: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

/**
 * Merge pool rows whose name contains the preview keyword (higher-signal,
 * e.g. a TV-channel 包丁) ahead of the fresh Rakuten results, de-duped by
 * source_url, capped at `target`. Non-matching pool rows are dropped.
 */
export function mergePreviewByKeyword(
	pool: DiscoveredProduct[],
	fresh: DiscoveredProduct[],
	keyword: string | null,
	target = PREVIEW_TARGET,
): DiscoveredProduct[] {
	const needle = keyword?.toLowerCase().trim() ?? "";
	const poolMatches =
		needle.length >= 2 ? pool.filter((p) => p.name.toLowerCase().includes(needle)) : [];
	const merged: DiscoveredProduct[] = [];
	const seen = new Set<string>();
	for (const p of [...poolMatches, ...fresh]) {
		if (!p.source_url || seen.has(p.source_url)) continue;
		seen.add(p.source_url);
		merged.push(p);
		if (merged.length >= target) break;
	}
	return merged;
}
