import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export type ProductRecommendation = {
	name: string;
	reason: string;
	japan_fit_score: number;
	estimated_demand: string;
	supply_source: string;
	estimated_price_jpy: string;
};

export type RecommendResponse = {
	recommendations: ProductRecommendation[];
	category: string;
	targetMarket: string;
	generatedAt: string;
};

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const { category, targetMarket, priceRange } = body;

	if (!category || !targetMarket) {
		return NextResponse.json(
			{ error: "category and targetMarket are required" },
			{ status: 400 },
		);
	}

	const supabase = getServiceClient();

	// Fetch existing high-scoring products from DB for context
	const { data: existingProducts } = await supabase
		.from("research_results")
		.select("product_id, japan_export_fit_score, raw_json")
		.gte("japan_export_fit_score", 70)
		.order("japan_export_fit_score", { ascending: false })
		.limit(5);

	const existingContext =
		existingProducts
			?.map((p) => {
				const info = p.raw_json?.product_info as { name?: string } | undefined;
				return `- ${info?.name ?? "Unknown"}: Japan fit score ${p.japan_export_fit_score}`;
			})
			.join("\n") ?? "";

	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

	const prompt = `You are a Japan home shopping market expert. Recommend 5 specific products that would sell well in Japan's home shopping market.

Category: ${category}
Target Market: ${targetMarket}
${priceRange ? `Price Range: ${priceRange}` : ""}

${existingContext ? `High-performing products in our database (for reference):\n${existingContext}\n` : ""}

For each product, consider:
- Japanese consumer preferences (quality, trust, unique features)
- Japan home shopping demographics (mainly 40-60s, female)
- Regulatory compliance (import regulations)
- Competitor landscape

Return a JSON array of exactly 5 recommendations:
[
  {
    "name": "<specific product name>",
    "reason": "<why this product fits Japan market in 2-3 sentences>",
    "japan_fit_score": <0-100>,
    "estimated_demand": "<e.g. 高 (週500-1000個)>",
    "supply_source": "<e.g. 韓国OEM メーカー, 中国 Alibaba>",
    "estimated_price_jpy": "<e.g. ¥3,980-5,980>"
  }
]

Return only valid JSON, no markdown.`;

	const result = await model.generateContent(prompt);
	const text = result.response.text().trim();
	const jsonMatch = text.match(/\[[\s\S]*\]/);

	if (!jsonMatch) {
		return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 });
	}

	const recommendations = JSON.parse(jsonMatch[0]) as ProductRecommendation[];

	return NextResponse.json({
		recommendations,
		category,
		targetMarket,
		generatedAt: new Date().toISOString(),
	} satisfies RecommendResponse);
}
