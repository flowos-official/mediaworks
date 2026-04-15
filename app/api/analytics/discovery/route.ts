import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { discoverNewProducts, type DiscoveryBatch } from "@/lib/md-strategy";
import { buildTVShoppingProfile } from "@/lib/tv-shopping-profile";

export const maxDuration = 120;

// POST: Run product discovery (new session or append to existing)
export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const {
		sessionId,
		context = "home_shopping",
		category,
		targetMarket,
		priceRange,
		userGoal,
		focus,
	} = body as {
		sessionId?: string;
		context?: "home_shopping" | "live_commerce";
		category?: string;
		targetMarket?: string;
		priceRange?: string;
		userGoal?: string;
		focus?: string;
	};

	const supabase = getServiceClient();

	// Load prior history if appending to existing session
	let priorHistory: DiscoveryBatch[] = [];
	if (sessionId) {
		const { data: session } = await supabase
			.from("discovery_sessions")
			.select("discovery_history")
			.eq("id", sessionId)
			.single();
		priorHistory = (session?.discovery_history as DiscoveryBatch[]) ?? [];
	}

	const excludeUrls = priorHistory
		.flatMap((b) => b.products.map((p) => p.source_url))
		.filter((u): u is string => !!u);
	const excludeNames = priorHistory.flatMap((b) => b.products.map((p) => p.name));

	// Fetch TV sales signals + category data for profile building
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
	const tvMarginRate = totalRevenue > 0
		? Math.round((totalProfit / totalRevenue) * 10000) / 100
		: 0;

	const discovered = await discoverNewProducts({
		context,
		topCategoryNames,
		explicitCategory: focus || category || undefined,
		targetMarket: targetMarket || undefined,
		priceRange: priceRange || undefined,
		userGoal: focus
			? `${userGoal ?? ""}\n追加フォーカス: ${focus}`.trim()
			: userGoal || undefined,
		tvProductNames: products.map((p) => p.product_name),
		tvMarginRate,
		excludeUrls,
		excludeNames,
		tvProfile,
		lightweight: true,
	});

	if (!discovered || discovered.length === 0) {
		return Response.json(
			{ error: "新商品を発掘できませんでした。条件を変えて再度お試しください。" },
			{ status: 422 },
		);
	}

	const newBatch: DiscoveryBatch = {
		generatedAt: new Date().toISOString(),
		focus: focus || undefined,
		products: discovered,
	};
	const updatedHistory = [newBatch, ...priorHistory];

	// Upsert session
	if (sessionId) {
		const { error: updateErr } = await supabase
			.from("discovery_sessions")
			.update({
				discovery_history: updatedHistory as unknown as Record<string, unknown>[],
				updated_at: new Date().toISOString(),
			})
			.eq("id", sessionId);

		if (updateErr) {
			return Response.json({ error: updateErr.message }, { status: 500 });
		}
	} else {
		const { data: newSession } = await supabase
			.from("discovery_sessions")
			.insert({
				context,
				category: category || null,
				target_market: targetMarket || null,
				price_range: priceRange || null,
				user_goal: userGoal || null,
				discovery_history: updatedHistory as unknown as Record<string, unknown>[],
			})
			.select("id")
			.single();

		return Response.json({
			sessionId: newSession?.id,
			batch: newBatch,
			discovery_history: updatedHistory,
		});
	}

	return Response.json({
		sessionId,
		batch: newBatch,
		discovery_history: updatedHistory,
	});
}

// GET: Load saved discovery sessions list
export async function GET() {
	const supabase = getServiceClient();
	const { data, error } = await supabase
		.from("discovery_sessions")
		.select("id, context, category, user_goal, created_at, updated_at, discovery_history")
		.order("updated_at", { ascending: false })
		.limit(20);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}

	return Response.json({ sessions: data ?? [] });
}
