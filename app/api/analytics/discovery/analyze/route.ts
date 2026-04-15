import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { analyzeDiscoveredProduct, type DiscoveredProduct, type DiscoveryBatch } from "@/lib/md-strategy";
import { buildTVShoppingProfile } from "@/lib/tv-shopping-profile";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const { sessionId, sourceUrl, productName } = body as {
		sessionId?: string;
		sourceUrl?: string;
		productName?: string;
	};

	if (!sessionId || !sourceUrl) {
		return Response.json({ error: "sessionId and sourceUrl are required" }, { status: 400 });
	}

	const supabase = getServiceClient();

	// 1. Load session and find the product
	const { data: session, error: sessionErr } = await supabase
		.from("discovery_sessions")
		.select("context, discovery_history")
		.eq("id", sessionId)
		.single();

	if (sessionErr || !session) {
		return Response.json({ error: "Session not found" }, { status: 404 });
	}

	const history = (session.discovery_history as DiscoveryBatch[]) ?? [];
	let product: DiscoveredProduct | undefined;
	for (const batch of history) {
		product = batch.products.find((p) => p.source_url === sourceUrl);
		if (product) break;
	}

	if (!product) {
		return Response.json({ error: "Product not found in session" }, { status: 404 });
	}

	// 2. Fetch TV sales data for profile (parallel queries, no Brave Search)
	const [productResult, categoryResult] = await Promise.all([
		supabase
			.from("product_summaries")
			.select("*")
			.in("year", [2025, 2026])
			.order("total_revenue", { ascending: false })
			.limit(60),
		supabase
			.from("category_summaries")
			.select("*")
			.in("year", [2025, 2026]),
	]);

	const profile = buildTVShoppingProfile(
		productResult.data ?? [],
		categoryResult.data ?? [],
	);

	// 3. Run per-product analysis
	const context = (session.context as "home_shopping" | "live_commerce") ?? "home_shopping";
	const salesStrategy = await analyzeDiscoveredProduct(product, profile, context);

	// 4. Upsert to discovery_product_analyses
	const { error: upsertErr } = await supabase
		.from("discovery_product_analyses")
		.upsert(
			{
				session_id: sessionId,
				source_url: sourceUrl,
				product_name: productName || product.name,
				sales_strategy: salesStrategy as unknown as Record<string, unknown>,
			},
			{ onConflict: "session_id,source_url" },
		);

	if (upsertErr) {
		console.error("[discovery/analyze] upsert error:", upsertErr);
		return Response.json({ error: upsertErr.message }, { status: 500 });
	}

	return Response.json({ sales_strategy: salesStrategy });
}
