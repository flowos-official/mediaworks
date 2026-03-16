import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { synthesizeResearch } from "@/lib/gemini";
import { runProductResearch } from "@/lib/brave";
import type { ProductInfo } from "@/lib/gemini";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
	// Verify cron secret
	const authHeader = request.headers.get("authorization");
	const cronSecret = process.env.CRON_SECRET;

	if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const supabase = getServiceClient();
	const startedAt = new Date().toISOString();
	const results: Array<{ productId: string; name: string; status: string; error?: string }> = [];

	try {
		// Fetch all completed products
		const { data: products, error: fetchError } = await supabase
			.from("products")
			.select("id, name, description, category, features, price_range, target_market")
			.eq("status", "completed")
			.order("created_at", { ascending: false })
			.limit(20); // Process max 20 per run to avoid timeout

		if (fetchError) throw fetchError;
		if (!products || products.length === 0) {
			return NextResponse.json({ message: "No completed products to refresh", refreshed: 0 });
		}

		console.log(`[daily-refresh] Processing ${products.length} products...`);

		for (const product of products) {
			try {
				const productInfo: ProductInfo = {
					name: product.name || "Unknown",
					description: product.description || "",
					features: product.features || [],
					category: product.category || "General",
					price_range: product.price_range,
					target_market: product.target_market,
				};

				// Re-run research
				const searchResults = await runProductResearch(productInfo.name, productInfo.category);
				const research = await synthesizeResearch(productInfo, searchResults);

				// Upsert research results
				const { error: upsertError } = await supabase
					.from("research_results")
					.upsert(
						{
							product_id: product.id,
							marketability_score: research.marketability_score,
							marketability_description: research.marketability_description,
							demographics: research.demographics,
							seasonality: research.seasonality,
							cogs_estimate: research.cogs_estimate,
							influencers: research.influencers,
							content_ideas: research.content_ideas,
							competitor_analysis: research.competitor_analysis,
							recommended_price_range: research.recommended_price_range,
							broadcast_scripts: research.broadcast_scripts,
							japan_export_fit_score: research.japan_export_fit_score,
							distribution_channels: research.distribution_channels,
							pricing_strategy: research.pricing_strategy,
							marketing_strategy: research.marketing_strategy,
							korea_market_fit: research.korea_market_fit,
							raw_json: {
								product_info: productInfo,
								search_results: searchResults,
								research,
								refreshed_at: new Date().toISOString(),
							},
						},
						{ onConflict: "product_id" },
					);

				if (upsertError) throw upsertError;

				results.push({ productId: product.id, name: product.name, status: "refreshed" });
				console.log(`[daily-refresh] ✓ ${product.name}`);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				results.push({ productId: product.id, name: product.name, status: "failed", error: msg });
				console.error(`[daily-refresh] ✗ ${product.name}:`, msg);
			}
		}

		const refreshed = results.filter((r) => r.status === "refreshed").length;
		const failed = results.filter((r) => r.status === "failed").length;

		return NextResponse.json({
			message: "Daily refresh completed",
			startedAt,
			completedAt: new Date().toISOString(),
			refreshed,
			failed,
			results,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[daily-refresh] Fatal error:", msg);
		return NextResponse.json({ error: msg }, { status: 500 });
	}
}
