import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { discoverNewProducts, type DiscoveryBatch } from "@/lib/md-strategy";
import type { PlatformAnalysisOutput } from "@/lib/live-commerce-strategy";
import { buildTVShoppingProfile } from "@/lib/tv-shopping-profile";

export const maxDuration = 120;

// POST: Re-run product discovery for an existing live commerce strategy.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const body = await request.json().catch(() => ({}));
	const focus: string | undefined = body.focus || undefined;

	const supabase = getServiceClient();

	const { data: strategy, error: fetchErr } = await supabase
		.from("live_commerce_strategies")
		.select("*")
		.eq("id", id)
		.single();

	if (fetchErr || !strategy) {
		return Response.json({ error: fetchErr?.message ?? "Strategy not found" }, { status: 404 });
	}

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
	const priorPa = (strategy.platform_analysis ?? {}) as PlatformAnalysisOutput;
	const priorHistory = priorPa.discovery_history ?? [];
	const excludeUrls = priorHistory
		.flatMap((b) => b.products.map((p) => p.source_url))
		.filter((u): u is string => !!u);
	const excludeNames = priorHistory.flatMap((b) => b.products.map((p) => p.name));

	const discovered = await discoverNewProducts({
		context: "live_commerce",
		topCategoryNames,
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

	const newBatch: DiscoveryBatch = {
		generatedAt: new Date().toISOString(),
		focus,
		products: discovered,
	};

	const pa = (strategy.platform_analysis ?? {}) as PlatformAnalysisOutput;
	const history = pa.discovery_history ?? [];
	const updatedPa: PlatformAnalysisOutput = {
		...pa,
		discovered_new_products: discovered,
		discovery_history: [newBatch, ...history],
	};

	const { error: updateErr } = await supabase
		.from("live_commerce_strategies")
		.update({ platform_analysis: updatedPa as unknown as Record<string, unknown> })
		.eq("id", id);

	if (updateErr) {
		return Response.json({ error: updateErr.message }, { status: 500 });
	}

	return Response.json({
		batch: newBatch,
		discovery_history: updatedPa.discovery_history,
	});
}
