/**
 * Pool query — fetches candidates from discovered_products for strategy generation.
 *
 * 決定規則 (plan §Core Decision Rules):
 * - R1: tv_tier ASC, tv_fit_score DESC, created_at DESC
 * - R2: exclude user_action IN ('rejected','duplicate')
 * - R3: context filter
 * - R4: category fuzzy match (category OR seed_keyword), fail-open at <5
 * - R4.5: intent keyword fuzzy match (DiscoverIntent — seasonal/theme/category),
 *         matched against name + category + seed_keyword + tv_fit_reason.
 *         Fail-open at <5 to preserve pool when intent is too narrow.
 * - R5: price range filter, NULL pass-through, fail-open at <5
 * - R6: lookback window (default 60d, env STRATEGY_POOL_LOOKBACK_DAYS)
 */

import { getServiceClient } from "@/lib/supabase";
import { buildCategoryMatchTerms } from "@/lib/strategy/category-mapping";

const FAIL_OPEN_THRESHOLD = 5;
const DEFAULT_LOOKBACK_DAYS = 60;

export interface PoolQueryInput {
	context: "home_shopping" | "live_commerce";
	uiCategory?: string; // 사용자 UI 라벨 (e.g. "美容・スキンケア")
	priceRange?: { min: number; max: number };
	limit?: number; // R7
	excludeProductIds?: string[]; // 이미 시드로 사용된 ID
	supplementCategoriesFromSeeds?: string[]; // 시드 상품의 카테고리 (보조 신호)
	/**
	 * R4.5 — DiscoverIntent fuzzy match terms (season/theme/category hints).
	 * Each term is matched as a case-insensitive substring against the
	 * concatenation of name + category + seed_keyword + tv_fit_reason.
	 * A row passes if ANY term matches. Fail-open at <5 results.
	 */
	intentKeywords?: string[];
	/**
	 * Phase 0.5 SearchIntent — granularity tier of the user's goal.
	 * Defaults to "broad" downstream when omitted. Threaded through but
	 * NOT yet consumed by applyFilters (Task 15 wires it up).
	 */
	intentTier?: "broad" | "seasonal" | "genre" | "specific_keyword";
	/** Phase 0.5 — normalized specific keyword (when intent_tier === "specific_keyword"). */
	specificKeyword?: string;
	/** Phase 0.5 — alias variants for the specific keyword. */
	specificAliases?: string[];
}

export interface PoolRow {
	id: string;
	name: string;
	product_url: string;
	price_jpy: number | null;
	category: string | null;
	seed_keyword: string;
	source: "rakuten" | "brave" | "tv_channel" | "other";
	tv_fit_score: number;
	tv_fit_reason: string | null;
	tv_channel_source: string | null;
	tv_tier: number;
	context: "home_shopping" | "live_commerce";
	user_action: "sourced" | "interested" | "rejected" | "duplicate" | null;
	c_package: Record<string, unknown> | null;
	enrichment_status: "idle" | "queued" | "running" | "completed" | "failed";
	review_count: number | null;
	review_avg: number | null;
	seller_name: string | null;
	broadcast_tag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
	thumbnail_url: string | null;
	created_at: string;
	tv_evidence: import("@/lib/discovery/types").TvEvidence | null;
}

interface FilterOptions {
	context: "home_shopping" | "live_commerce";
	uiCategory?: string;
	priceRange?: { min: number; max: number };
	supplementCategories?: string[];
	intentKeywords?: string[];
	// Phase 0.5 SearchIntent — threaded through but not yet consumed by applyFilters (Task 15).
	intentTier?: "broad" | "seasonal" | "genre" | "specific_keyword";
	specificKeyword?: string;
	specificAliases?: string[];
}

function applyFilters(rows: PoolRow[], opts: FilterOptions): PoolRow[] {
	// R3 + R2 — always strict
	const baseFiltered = rows.filter(
		(r) =>
			r.context === opts.context &&
			r.user_action !== "rejected" &&
			r.user_action !== "duplicate",
	);

	// R4 — category fuzzy match with fail-open
	// Fail-open kicks in only when the input pool itself is too thin (< THRESHOLD)
	// to apply a meaningful filter; otherwise honor the strict result even if small.
	let afterCategory = baseFiltered;
	if (opts.uiCategory && baseFiltered.length >= FAIL_OPEN_THRESHOLD) {
		const matchTerms = buildCategoryMatchTerms([
			opts.uiCategory,
			...(opts.supplementCategories ?? []),
		]);
		if (matchTerms.length > 0) {
			afterCategory = baseFiltered.filter((r) => {
				const hay = `${r.category ?? ""} ${r.seed_keyword}`.toLowerCase();
				return matchTerms.some((t) => hay.includes(t.toLowerCase()));
			});
		}
	}

	// Tier 4 — specific_keyword: hard substring match, fail-open OFF
	if (opts.intentTier === "specific_keyword" && opts.specificKeyword) {
		const needles = [opts.specificKeyword, ...(opts.specificAliases ?? [])]
			.map((s) => s.toLowerCase().trim())
			.filter((s) => s.length >= 2);
		if (needles.length > 0) {
			const matched = afterCategory.filter((r) => {
				const hay = `${r.name ?? ""} ${r.category ?? ""}`.toLowerCase();
				return needles.some((n) => hay.includes(n));
			});
			console.log(
				`[pool-query] tier=specific_keyword fail_open=off match_count=${matched.length}`,
			);
			return applyPriceFilter(matched, opts);
		}
	}

	// R4.5 — intent keyword fuzzy match with fail-open
	let afterIntent = afterCategory;
	const intentTerms = (opts.intentKeywords ?? [])
		.map((t) => t.trim().toLowerCase())
		.filter((t) => t.length > 0);
	if (intentTerms.length > 0 && afterCategory.length >= FAIL_OPEN_THRESHOLD) {
		const matched = afterCategory.filter((r) => {
			const hay = `${r.name ?? ""} ${r.category ?? ""} ${r.seed_keyword ?? ""} ${r.tv_fit_reason ?? ""}`.toLowerCase();
			return intentTerms.some((t) => hay.includes(t));
		});
		// Fail-open: if intent shrinks the pool below threshold, keep the
		// pre-intent set (user intent is preferred but never starves the pool).
		afterIntent = matched.length >= FAIL_OPEN_THRESHOLD ? matched : afterCategory;
	}

	// R5 — price filter with NULL pass-through + fail-open (same pool-size gate)
	return applyPriceFilter(afterIntent, opts);
}

function applyPriceFilter(rows: PoolRow[], opts: FilterOptions): PoolRow[] {
	if (!opts.priceRange || rows.length < FAIL_OPEN_THRESHOLD) return rows;
	const { min, max } = opts.priceRange;
	return rows.filter(
		(r) => r.price_jpy === null || (r.price_jpy >= min && r.price_jpy <= max),
	);
}

/**
 * Query discovered_products with all filters and ordering applied.
 * Returns up to input.limit rows. Falls back gracefully on DB errors (empty array).
 */
export async function queryDiscoveredPool(
	input: PoolQueryInput,
): Promise<PoolRow[]> {
	const sb = getServiceClient();
	const parsedLookback = Number(process.env.STRATEGY_POOL_LOOKBACK_DAYS);
	const lookbackDays =
		Number.isFinite(parsedLookback) && parsedLookback > 0
			? parsedLookback
			: DEFAULT_LOOKBACK_DAYS;
	const sinceIso = new Date(
		Date.now() - lookbackDays * 24 * 3600 * 1000,
	).toISOString();
	const limit = input.limit ?? 30;
	// Over-fetch to give filters room; we'll trim after.
	const fetchLimit = Math.min(500, limit * 5);

	let q = sb
		.from("discovered_products")
		.select(
			"id, name, product_url, price_jpy, category, seed_keyword, source, tv_fit_score, tv_fit_reason, tv_channel_source, tv_tier, context, user_action, c_package, enrichment_status, review_count, review_avg, seller_name, broadcast_tag, thumbnail_url, created_at, tv_evidence",
		)
		.eq("context", input.context)
		.gte("created_at", sinceIso)
		.order("tv_tier", { ascending: true })
		.order("tv_fit_score", { ascending: false })
		.order("created_at", { ascending: false })
		.limit(fetchLimit);

	if (input.excludeProductIds && input.excludeProductIds.length > 0) {
		const UUID_RE =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		const validIds = input.excludeProductIds.filter((id) => UUID_RE.test(id));
		if (validIds.length > 0) {
			q = q.not("id", "in", `(${validIds.join(",")})`);
		}
	}

	const { data, error } = await q;
	if (error) {
		console.warn("[pool-query] query failed:", error.message);
		return [];
	}
	const rows = (data ?? []) as PoolRow[];

	const filtered = applyFilters(rows, {
		context: input.context,
		uiCategory: input.uiCategory,
		priceRange: input.priceRange,
		supplementCategories: input.supplementCategoriesFromSeeds,
		intentKeywords: input.intentKeywords,
		intentTier: input.intentTier,
		specificKeyword: input.specificKeyword,
		specificAliases: input.specificAliases,
	});

	return filtered.slice(0, limit);
}

export const __test = {
	applyFilters,
};
