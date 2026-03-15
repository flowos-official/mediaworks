import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { synthesizeResearch } from "@/lib/gemini";
import { runProductResearch } from "@/lib/brave";
import type { ProductInfo } from "@/lib/gemini";

export const maxDuration = 300; // Vercel Pro max (800s)

export async function POST(request: NextRequest) {
	const { productId } = await request.json();

	if (!productId) {
		return NextResponse.json({ error: "productId required" }, { status: 400 });
	}

	const supabase = getServiceClient();

	try {
		// Get product info from DB
		const { data: product, error: productError } = await supabase
			.from("products")
			.select("*")
			.eq("id", productId)
			.single();

		if (productError || !product) {
			return NextResponse.json({ error: "Product not found" }, { status: 404 });
		}

		// Build ProductInfo from stored data
		const productInfo: ProductInfo = {
			name: product.name || "Unknown Product",
			description: product.description || "",
			features: product.features || [],
			category: product.category || "General",
			price_range: product.price_range,
			target_market: product.target_market,
		};

		// Update status
		await supabase
			.from("products")
			.update({ status: "analyzing" })
			.eq("id", productId);

		// Step 1: Run web research with Brave (includes Japan queries)
		console.log(`[${productId}] Running web research (incl. Japan market)...`);
		const searchResults = await runProductResearch(
			productInfo.name,
			productInfo.category,
		);

		// Step 2: Synthesize research with Gemini Pro
		console.log(`[${productId}] Synthesizing research with gemini-3.1-pro...`);
		const research = await synthesizeResearch(productInfo, searchResults);

		// Step 3: Save research results
		const { error: researchError } = await supabase
			.from("research_results")
			.upsert(
				{
					product_id: productId,
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
					raw_json: {
						product_info: productInfo,
						search_results: searchResults,
						research,
					},
				},
				{ onConflict: "product_id" },
			);

		if (researchError) {
			throw researchError;
		}

		// Update product status to completed
		await supabase
			.from("products")
			.update({ status: "completed" })
			.eq("id", productId);

		console.log(`[${productId}] Synthesis completed`);
		return NextResponse.json({ success: true });
	} catch (error) {
		console.error(`[${productId}] Synthesis failed:`, error);

		await supabase
			.from("products")
			.update({ status: "failed" })
			.eq("id", productId);

		return NextResponse.json(
			{ error: "Synthesis failed" },
			{ status: 500 },
		);
	}
}
