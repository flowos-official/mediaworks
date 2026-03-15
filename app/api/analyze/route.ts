import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { extractProductInfo } from "@/lib/gemini";

export const maxDuration = 60; // Only extraction now — fast

export async function POST(request: NextRequest) {
	const { productId, fileBase64, mimeType, fileName } = await request.json();

	const supabase = getServiceClient();

	try {
		// Update status to analyzing
		await supabase
			.from("products")
			.update({ status: "analyzing" })
			.eq("id", productId);

		// Step 1: Extract product info with Gemini (fast — typically <30s)
		console.log(`[${productId}] Extracting product info...`);
		const productInfo = await extractProductInfo(fileBase64, mimeType, fileName);

		// Update product name, description, and metadata — status: extracted
		await supabase
			.from("products")
			.update({
				name: productInfo.name,
				description: productInfo.description,
				category: productInfo.category,
				features: productInfo.features,
				price_range: productInfo.price_range,
				target_market: productInfo.target_market,
				status: "extracted",
			})
			.eq("id", productId);

		// Step 2: Trigger synthesize in a separate request (non-blocking)
		// This runs as a separate serverless function with its own 5-min timeout
		const baseUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
		fetch(`${baseUrl}/api/analyze/synthesize`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productId }),
		}).catch((err) => {
			console.error(`[${productId}] Failed to trigger synthesize:`, err);
		});

		console.log(`[${productId}] Extraction done, synthesis triggered async`);
		return NextResponse.json({
			success: true,
			productInfo,
			message: "Extraction complete. Synthesis running in background.",
		});
	} catch (error) {
		console.error(`[${productId}] Extraction failed:`, error);

		await supabase
			.from("products")
			.update({ status: "failed" })
			.eq("id", productId);

		return NextResponse.json(
			{ error: "Analysis failed" },
			{ status: 500 },
		);
	}
}
