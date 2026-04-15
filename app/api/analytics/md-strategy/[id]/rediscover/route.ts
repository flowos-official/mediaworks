import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { discoverNewProducts, type ProductSelectionOutput, type DiscoveryBatch } from "@/lib/md-strategy";
import { buildTVShoppingProfile } from "@/lib/tv-shopping-profile";

export const maxDuration = 120;

// POST: Re-run product discovery for an existing strategy.
// Reuses the strategy's stored signals; optionally accepts a focus override.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const body = await request.json().catch(() => ({}));
	const focus: string | undefined = body.focus || undefined;

	const supabase = getServiceClient();

	// 1) Load the saved strategy
	const { data: strategy, error: fetchErr } = await supabase
		.from("md_strategies")
		.select("*")
		.eq("id", id)
		.single();

	if (fetchErr || !strategy) {
		return Response.json({ error: fetchErr?.message ?? "Strategy not found" }, { status: 404 });
	}

	// 2) Re-fetch top categories from product_summaries (signal source)
	const [productResult, annualResult, categoryResult] = await Promise.all([
		supabase
			.from("product_summaries")
			.select("*")
			.in("year", [2025, 2026])
			.order("total_revenue", { ascending: false })
			.limit(60),
		supabase
			.from("annual_summaries")
			.select("total_revenue, total_profit")
			.in("year", [2025, 2026]),
		supabase
			.from("category_summaries")
			.select("*")
			.in("year", [2025, 2026]),
	]);

	const products = productResult.data ?? [];
	const annuals = annualResult.data ?? [];
	const tvProfile = buildTVShoppingProfile(products, categoryResult.data ?? []);

	const categoryRevenue: Record<string, number> = {};
	for (const p of products) {
		const cat = p.category ?? "その他";
		categoryRevenue[cat] = (categoryRevenue[cat] ?? 0) + (p.total_revenue ?? 0);
	}
	const topCategoryNames = Object.entries(categoryRevenue)
		.sort(([, a], [, b]) => b - a)
		.slice(0, 3)
		.map(([cat]) => cat);

	const totalRevenue = annuals.reduce((s, a) => s + (a.total_revenue ?? 0), 0);
	const totalProfit = annuals.reduce((s, a) => s + (a.total_profit ?? 0), 0);
	const tvMarginRate = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0;

	// Collect exclusion lists from prior discovery batches
	const priorPs = (strategy.product_selection ?? {}) as ProductSelectionOutput;
	const priorHistory = priorPs.discovery_history ?? [];
	const excludeUrls = priorHistory
		.flatMap((b) => b.products.map((p) => p.source_url))
		.filter((u): u is string => !!u);
	const excludeNames = priorHistory.flatMap((b) => b.products.map((p) => p.name));

	// 3) Run discovery
	const discovered = await discoverNewProducts({
		context: "home_shopping",
		topCategoryNames,
		explicitCategory: focus || strategy.category || undefined,
		targetMarket: strategy.target_market || undefined,
		priceRange: strategy.price_range || undefined,
		userGoal: focus
			? `${strategy.user_goal ?? ""}\n追加フォーカス: ${focus}`.trim()
			: strategy.user_goal || undefined,
		tvProductNames: products.map((p) => p.product_name),
		tvMarginRate,
		excludeUrls,
		excludeNames,
		tvProfile,
		lightweight: true,
	});

	if (!discovered || discovered.length === 0) {
		return Response.json(
			{ error: "新商品を発掘できませんでした (検索結果が空)" },
			{ status: 422 },
		);
	}

	// 4) Append batch to product_selection.discovery_history (JSONB)
	const newBatch: DiscoveryBatch = {
		generatedAt: new Date().toISOString(),
		focus,
		products: discovered,
	};

	const ps = (strategy.product_selection ?? {}) as ProductSelectionOutput;
	const history = ps.discovery_history ?? [];
	const updatedPs: ProductSelectionOutput = {
		...ps,
		discovered_new_products: discovered,
		discovery_history: [newBatch, ...history],
	};

	const { error: updateErr } = await supabase
		.from("md_strategies")
		.update({ product_selection: updatedPs as unknown as Record<string, unknown> })
		.eq("id", id);

	if (updateErr) {
		return Response.json({ error: updateErr.message }, { status: 500 });
	}

	return Response.json({
		batch: newBatch,
		discovery_history: updatedPs.discovery_history,
	});
}
