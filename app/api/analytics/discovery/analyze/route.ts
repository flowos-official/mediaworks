import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { analyzeDiscoveredProduct, type DiscoveredProduct, type DiscoveryBatch } from "@/lib/md-strategy";
import { buildTVShoppingProfile } from "@/lib/tv-shopping-profile";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const {
		sessionId,
		sourceUrl,
		productName,
		product: directProduct,
		context: directContext,
	} = body as {
		sessionId?: string;
		sourceUrl?: string;
		productName?: string;
		product?: DiscoveredProduct;
		context?: "home_shopping" | "live_commerce";
	};

	if (!sourceUrl) {
		return Response.json({ error: "sourceUrl is required" }, { status: 400 });
	}

	const supabase = getServiceClient();

	// Resolve product: either from session or directly provided
	let product: DiscoveredProduct | undefined = directProduct;
	let context: "home_shopping" | "live_commerce" = directContext ?? "home_shopping";

	if (!product && sessionId) {
		const { data: session, error: sessionErr } = await supabase
			.from("discovery_sessions")
			.select("context, discovery_history")
			.eq("id", sessionId)
			.single();

		if (sessionErr || !session) {
			return Response.json({ error: "Session not found" }, { status: 404 });
		}

		context = (session.context as "home_shopping" | "live_commerce") ?? "home_shopping";
		const history = (session.discovery_history as DiscoveryBatch[]) ?? [];
		for (const batch of history) {
			product = batch.products.find((p) => p.source_url === sourceUrl);
			if (product) break;
		}
	}

	if (!product) {
		return Response.json({ error: "Product not found" }, { status: 404 });
	}

	// Fetch TV sales data for profile
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

	const salesStrategy = await analyzeDiscoveredProduct(product, profile, context);

	// Save to discovery_product_analyses if sessionId provided
	if (sessionId) {
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
		}
	}

	return Response.json({ sales_strategy: salesStrategy });
}
