import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import {
	buildProductInfoFromProductRow,
	buildResearchResultInsert,
	runProductSynthesis,
} from "@/lib/research/synthesize-product";

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
				const productInfo = buildProductInfoFromProductRow(product);

				// Re-run research through the shared synthesis core (carries competitor
				// broadcast context + koreaFit sanitization, same as the initial-analyze path).
				// On failure we keep the product 'completed' (preserve prior good research) —
				// refresh never marks status, unlike synthesizeProductResearch.
				const { searchResults, research } = await runProductSynthesis(
					productInfo,
					product.name ?? product.id,
				);

				const { error: upsertError } = await supabase
					.from("research_results")
					.upsert(
						buildResearchResultInsert(product.id, productInfo, searchResults, research),
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
