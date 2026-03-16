import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 60;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

async function braveSearch(query: string): Promise<Array<{ title: string; url: string; description: string }>> {
	if (!BRAVE_API_KEY) return [];
	try {
		const res = await fetch(
			`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
			{
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "gzip",
					"X-Subscription-Token": BRAVE_API_KEY,
				},
				signal: AbortSignal.timeout(4000),
			},
		);
		if (!res.ok) return [];
		const data = await res.json();
		return (data.web?.results ?? []).slice(0, 5).map((r: { title?: string; url?: string; description?: string }) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			description: r.description ?? "",
		}));
	} catch {
		return [];
	}
}

export type ProductRecommendation = {
	name: string;
	reason: string;
	japan_fit_score: number;
	estimated_demand: string;
	supply_source: string;
	estimated_price_jpy: string;
	sources: Array<{ title: string; url: string }>;
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
		return NextResponse.json({ error: "category and targetMarket are required" }, { status: 400 });
	}

	const supabase = getServiceClient();

	// Run Brave searches + fetch existing DB context in parallel
	const [search1, search2, search3, existingProducts] = await Promise.all([
		braveSearch(`${category} 日本 人気 ランキング 2026`),
		braveSearch(`${category} 楽天 売れ筋 ランキング`),
		braveSearch(`${category} TikTokショップ 日本 トレンド`),
		supabase
			.from("research_results")
			.select("product_id, japan_export_fit_score, raw_json")
			.gte("japan_export_fit_score", 70)
			.order("japan_export_fit_score", { ascending: false })
			.limit(5)
			.then(({ data }) => data ?? []),
	]);

	// Format search results for prompt
	const formatResults = (results: typeof search1, label: string) => {
		if (!results.length) return "";
		return `${label}:\n${results.map((r) => `  - ${r.title}: ${r.description} (${r.url})`).join("\n")}`;
	};

	const searchContext = [
		formatResults(search1, `${category} 日本人気ランキング`),
		formatResults(search2, `${category} 楽天売れ筋`),
		formatResults(search3, `${category} TikTokショップトレンド`),
	].filter(Boolean).join("\n\n");

	// Collect all source URLs for the model to reference
	const allSources = [...search1, ...search2, ...search3];

	const existingContext = existingProducts
		.map((p) => {
			const info = p.raw_json?.product_info as { name?: string } | undefined;
			return `- ${info?.name ?? "Unknown"}: Japan fit score ${p.japan_export_fit_score}`;
		})
		.join("\n");

	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

	const prompt = `You are a Japan home shopping market expert. Based on REAL search data below, recommend 5 specific products.

Category: ${category}
Target Market: ${targetMarket}
${priceRange ? `Price Range: ${priceRange}` : ""}

=== Real Market Data (from Brave Search) ===
${searchContext || "No search data available — use your market knowledge."}

${existingContext ? `=== High-performing products in our database ===\n${existingContext}\n` : ""}

=== Available Sources (cite relevant ones per product) ===
${allSources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")}

For each recommendation, cite 1-3 source URLs from the list above that support the recommendation.

Return a JSON array of exactly 5 recommendations:
[
  {
    "name": "<specific product name>",
    "reason": "<why this product fits Japan market, referencing the search data>",
    "japan_fit_score": <0-100>,
    "estimated_demand": "<e.g. 高 (週500-1000個)>",
    "supply_source": "<e.g. 韓国OEM メーカー>",
    "estimated_price_jpy": "<e.g. ¥3,980-5,980>",
    "sources": [
      { "title": "<source title>", "url": "<source url>" }
    ]
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
