// lib/strategy/research-seed.ts
import { getServiceClient } from "@/lib/supabase";
import { mapUiCategoryToSalesCategories } from "@/lib/strategy/category-mapping";

export interface ResearchPoolItem {
	name: string;
	price?: number;
	source: "research";
	source_url: string;
	snippet: string;
	keyword: string;
	reviewCount?: number;
	reviewAverage?: number;
	pool_source: "research";
	discovered_product_id?: string;     // populated if the research product was promoted from Discovery
	tv_fit_score?: number;               // synthetic: research_results.japan_export_fit_score
	tv_fit_reason?: string;
	tv_channel_source?: string | null;
	c_package?: Record<string, unknown> | null;
}

export interface ResearchPoolInput {
	uiCategory?: string;
	limit: number;
	// Note: `context` and `priceRange` are deliberately omitted. The Research
	// pipeline does not partition products by context (home_shopping vs
	// live_commerce), and price filtering is handled at the curation prompt
	// layer where Gemini sees the full pool. If either filter is needed later,
	// add it then — don't accept-and-ignore.
}

const FAIL_OPEN_THRESHOLD = 5;
const DEFAULT_LOOKBACK_DAYS = 60;

function isoDaysAgo(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString();
}

interface ProductWithResearch {
	id: string;
	name: string;
	category: string | null;
	description: string | null;
	price_range: string | null;
	discovered_product_id: string | null;
	created_at: string;
	research_results: Array<{
		japan_export_fit_score: number | null;
		marketability_description: string | null;
		demographics: unknown;
	}> | null;
}

/**
 * Extracts a representative JPY number from a `products.price_range` string
 * like "¥3,980" or "¥1,000-¥5,000". For ranges, returns the midpoint.
 * Returns undefined when no number can be parsed.
 */
function parsePriceRangeStr(s: string | null | undefined): number | undefined {
	if (!s) return undefined;
	const nums = Array.from(s.matchAll(/(\d[\d,]*)/g)).map((m) =>
		Number(m[1].replace(/,/g, "")),
	);
	if (nums.length === 0) return undefined;
	if (nums.length === 1) return nums[0];
	return Math.round((nums[0] + nums[1]) / 2);
}

/**
 * Loads candidate products from the Research pipeline (completed reports
 * with japan_export_fit_score >= 60) as a fourth pool_source for
 * MD-Strategy. Returns at most `input.limit` items.
 *
 * Filters mirror queryDiscoveredPool's fail-open behavior on category
 * filters so the pool stays usable even when intent is narrow.
 */
export async function queryResearchPool(
	input: ResearchPoolInput,
): Promise<ResearchPoolItem[]> {
	const lookbackDays = Number(process.env.STRATEGY_POOL_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
	const sinceIso = isoDaysAgo(lookbackDays);
	const sb = getServiceClient();

	// Over-fetch to give filters room.
	const fetchLimit = Math.min(200, Math.max(input.limit * 5, 20));

	const { data, error } = await sb
		.from("products")
		.select(
			`id, name, category, description, price_range, discovered_product_id, created_at,
			 research_results!inner(japan_export_fit_score, marketability_description, demographics)`,
		)
		.eq("status", "completed")
		.gte("created_at", sinceIso)
		.order("created_at", { ascending: false })
		.limit(fetchLimit);

	if (error) {
		console.warn("[research-seed] query failed:", error.message);
		return [];
	}

	const rows = (data ?? []) as unknown as ProductWithResearch[];

	// Filter: japan_export_fit_score >= 60 (strict — no fail-open here).
	const scored = rows
		.map((r) => {
			const rr = Array.isArray(r.research_results) ? r.research_results[0] : null;
			return { row: r, research: rr };
		})
		.filter(
			(x) =>
				x.research?.japan_export_fit_score != null &&
				x.research.japan_export_fit_score >= 60,
		);

	// Category filter with fail-open.
	let afterCategory = scored;
	if (input.uiCategory && scored.length >= FAIL_OPEN_THRESHOLD) {
		const targets = mapUiCategoryToSalesCategories(input.uiCategory);
		const uiTokens = input.uiCategory
			.split("・")
			.map((s) => s.trim())
			.filter(Boolean);
		const matchTerms = Array.from(
			new Set(
				[...targets, input.uiCategory, ...uiTokens].filter(
					(s) => s.length > 0,
				),
			),
		);
		const filtered = scored.filter((x) =>
			matchTerms.some((term) =>
				(x.row.category ?? "").toLowerCase().includes(term.toLowerCase()),
			),
		);
		if (filtered.length >= FAIL_OPEN_THRESHOLD) {
			afterCategory = filtered;
		}
	}

	// Map to ResearchPoolItem.
	const items: ResearchPoolItem[] = afterCategory.slice(0, input.limit).map((x) => ({
		name: x.row.name,
		price: parsePriceRangeStr(x.row.price_range),
		source: "research" as const,
		source_url: `/products/${x.row.id}`,
		snippet: (x.research?.marketability_description ?? x.row.description ?? "").slice(0, 280),
		keyword: x.row.category ?? "",
		pool_source: "research" as const,
		discovered_product_id: x.row.discovered_product_id ?? undefined,
		tv_fit_score: x.research?.japan_export_fit_score ?? undefined,
		tv_fit_reason: x.research?.marketability_description ?? undefined,
		tv_channel_source: null,
		c_package: null,
	}));

	return items;
}
