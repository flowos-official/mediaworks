import type { ProductSummary, CategorySummary } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// TV Shopping Success Profile — data-driven context for Gemini curation
// ---------------------------------------------------------------------------

export interface TVShoppingProfile {
	priceSweetSpot: { min: number; max: number };
	avgMarginRate: number;
	minViableMargin: number;
	topCategories: Array<{
		name: string;
		revenueShare: number;
		marginRate: number;
		avgUnitPrice: number;
	}>;
	topProductExamples: Array<{
		name: string;
		category: string;
		unitPrice: number;
		marginRate: number;
		weeklyAvgQty: number;
	}>;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Build a TV shopping success profile from actual sales data.
 * Pure function — no DB calls, takes data as arguments.
 */
export function buildTVShoppingProfile(
	products: ProductSummary[],
	categories: CategorySummary[],
): TVShoppingProfile {
	// Filter to products with meaningful sales (avoid noise from test/return entries)
	const active = products.filter((p) => p.total_quantity > 0 && p.total_revenue > 0);

	// Unit prices
	const unitPrices = active
		.map((p) => Math.round(p.total_revenue / p.total_quantity))
		.sort((a, b) => a - b);

	const p25Price = percentile(unitPrices, 25);
	const p75Price = percentile(unitPrices, 75);

	// Margin rates
	const margins = active
		.map((p) => p.margin_rate)
		.filter((m) => m > 0)
		.sort((a, b) => a - b);

	const avgMarginRate = margins.length > 0
		? Math.round((margins.reduce((s, m) => s + m, 0) / margins.length) * 100) / 100
		: 0;
	const minViableMargin = percentile(margins, 25);

	// Category breakdown
	const totalRevenue = categories.reduce((s, c) => s + c.total_revenue, 0);
	const topCategories = categories
		.filter((c) => c.total_revenue > 0)
		.sort((a, b) => b.total_revenue - a.total_revenue)
		.slice(0, 6)
		.map((c) => {
			const catProducts = active.filter((p) => p.category === c.category);
			const catQty = catProducts.reduce((s, p) => s + p.total_quantity, 0);
			const catRev = catProducts.reduce((s, p) => s + p.total_revenue, 0);
			return {
				name: c.category,
				revenueShare: totalRevenue > 0
					? Math.round((c.total_revenue / totalRevenue) * 10000) / 100
					: 0,
				marginRate: c.margin_rate,
				avgUnitPrice: catQty > 0 ? Math.round(catRev / catQty) : 0,
			};
		});

	// Top product examples (by revenue)
	const topProductExamples = active
		.sort((a, b) => b.total_revenue - a.total_revenue)
		.slice(0, 8)
		.map((p) => ({
			name: p.product_name,
			category: p.category ?? "その他",
			unitPrice: Math.round(p.total_revenue / p.total_quantity),
			marginRate: p.margin_rate,
			weeklyAvgQty: Math.round(p.avg_weekly_qty),
		}));

	return {
		priceSweetSpot: { min: Math.round(p25Price), max: Math.round(p75Price) },
		avgMarginRate,
		minViableMargin: Math.round(minViableMargin * 100) / 100,
		topCategories,
		topProductExamples,
	};
}

/**
 * Format the profile as a prompt section for Gemini.
 */
export function formatProfileForPrompt(profile: TVShoppingProfile): string {
	const cats = profile.topCategories
		.map((c) => `  - ${c.name}: 売上比率${c.revenueShare}%, マージン${c.marginRate}%, 平均単価¥${c.avgUnitPrice.toLocaleString()}`)
		.join("\n");

	const products = profile.topProductExamples
		.map((p) => `  - ${p.name} (${p.category}): ¥${p.unitPrice.toLocaleString()} マージン${p.marginRate}% 週平均${p.weeklyAvgQty}個`)
		.join("\n");

	return `=== TV通販成功プロファイル (実績データ) ===
価格スイートスポット: ¥${profile.priceSweetSpot.min.toLocaleString()}〜¥${profile.priceSweetSpot.max.toLocaleString()} (実績p25-p75)
平均マージン率: ${profile.avgMarginRate}%
最低採算マージン: ${profile.minViableMargin}% (実績p25 — これを下回る商品は採算が厳しい)

トップカテゴリ (売上順):
${cats}

成功商品の実例:
${products}

※ 上記プロファイルに合致しない商品（価格帯外、マージン率不足、カテゴリ不一致）は選定を避けること。`;
}
