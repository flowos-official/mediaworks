/**
 * Preliminary discovery — fast, pool-only path used to surface new-product
 * candidates BEFORE the strategy-aware curated discovery runs at the end of
 * the workflow. No Gemini call, no fresh Rakuten/Brave searches; just a
 * single `discovered_products` query mapped to the same DiscoveredProduct
 * shape the hero already renders.
 *
 * The final curated discovery still runs after all skills complete and
 * replaces these items with the strategy-aligned set.
 */

import { queryDiscoveredPool, type PoolRow } from "@/lib/strategy/pool-query";
import { deriveIntentKeywords } from "@/lib/strategy/discover-intent";
import type { DiscoverIntent } from "@/lib/strategy/discover-intent";
import type { DiscoveredProduct } from "@/lib/md-strategy";
import { parsePriceRange } from "@/lib/strategy/parse-price-range";

const PRELIMINARY_TARGET = 15;

export interface PreliminaryDiscoveryInput {
	context: "home_shopping" | "live_commerce";
	uiCategory?: string;
	priceRange?: string;
	excludeProductIds?: string[];
	supplementCategoriesFromSeeds?: string[];
	intent?: DiscoverIntent;
}

// price parsing shared with the final discovery via parse-price-range.ts

function formatPriceJpy(price: number | null): string {
	if (price === null || !Number.isFinite(price) || price <= 0) return "価格未取得";
	return `¥${price.toLocaleString("ja-JP")}`;
}

function rowToDiscoveredProduct(r: PoolRow): DiscoveredProduct {
	const fitScore = r.tv_fit_score ?? 0;
	const fitReason = r.tv_fit_reason ?? "発掘プールからの暫定候補";
	const categoryLabel = r.category ?? "未分類";
	return {
		name: r.name,
		reason: `${fitReason} (カテゴリ: ${categoryLabel})`,
		japan_fit_score: fitScore,
		estimated_demand: "—",
		supply_source: r.seller_name ?? "—",
		estimated_price_jpy: formatPriceJpy(r.price_jpy),
		source: r.source,
		source_url: r.product_url,
		signal_basis: `発掘プール由来 (TV適合度 ${fitScore}/100)`,
		japan_market_fit: {
			popularity_evidence:
				r.review_count && r.review_avg
					? `レビュー${r.review_count}件・平均★${r.review_avg.toFixed(1)}`
					: "—",
			trend_context: fitReason,
			why_japan_now: "暫定先行表示 — 戦略分析完了後に精緻化されます",
		},
		pool_source: "discovery_pool",
		discovered_product_id: r.id,
		tv_channel_source: r.tv_channel_source,
	};
}

export async function runPreliminaryDiscovery(
	input: PreliminaryDiscoveryInput,
): Promise<DiscoveredProduct[]> {
	const priceRange = input.priceRange ? parsePriceRange(input.priceRange) : null;
	const rows = await queryDiscoveredPool({
		context: input.context,
		uiCategory: input.uiCategory,
		priceRange: priceRange ?? undefined,
		limit: PRELIMINARY_TARGET,
		excludeProductIds: input.excludeProductIds,
		supplementCategoriesFromSeeds: input.supplementCategoriesFromSeeds,
		intentKeywords: input.intent ? deriveIntentKeywords(input.intent) : undefined,
		specificKeyword: input.intent?.specific_keyword?.normalized,
		specificAliases: input.intent?.specific_keyword?.aliases ?? [],
		intentTier: input.intent?.intent_tier ?? "broad",
	});
	return rows.map(rowToDiscoveredProduct);
}
