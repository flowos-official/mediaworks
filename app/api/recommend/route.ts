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

	// Map AI recommend categories → sales_weekly categories
	const categoryMapping: Record<string, string[]> = {
		"美容・スキンケア": ["美容・運動", "化粧品"],
		"健康食品": ["食品"],
		"キッチン用品": ["キッチン"],
		"ファッション": ["アパレル", "靴・バッグ"],
		"生活雑貨": ["家電・雑貨", "掃除・洗濯"],
		"電気機器": ["家電・雑貨"],
		"フィットネス": ["美容・運動", "医療機器"],
		"その他": ["その他", "寝具", "宝飾", "防災・防犯", "ゴルフ"],
	};

	const salesCategories = categoryMapping[category] ?? [category];

	// Run Brave searches + fetch existing DB context + sales data in parallel
	const [search1, search2, search3, existingProducts, salesPerformance] = await Promise.all([
		braveSearch(`${category} 日本 人気 ランキング 2026`),
		braveSearch(`${category} 楽天 売れ筋 ランキング`),
		braveSearch(`${category} TikTokショップ 日本 トレンド`),
		supabase
			.from("research_results")
			.select("product_id, japan_export_fit_score, raw_json")
			.gte("japan_export_fit_score", 70)
			.order("japan_export_fit_score", { ascending: false })
			.limit(5)
			.then(({ data, error }) => {
				if (error) console.error("[recommend] research_results query failed:", error.message);
				return data ?? [];
			}),
		// Fetch actual TV sales performance from pre-computed summaries
		supabase
			.from("product_summaries")
			.select("product_name, total_revenue, total_profit, total_quantity, week_count, margin_rate, avg_weekly_qty")
			.in("category", salesCategories)
			.in("year", [2025, 2026])
			.order("total_revenue", { ascending: false })
			.limit(10)
			.then(({ data, error }) => {
				if (error) console.error("[recommend] product_summaries query failed:", error.message);
				if (!data || data.length === 0) return [];
				return data.map((p) => ({
					name: p.product_name,
					revenue: p.total_revenue ?? 0,
					profit: p.total_profit ?? 0,
					qty: p.total_quantity ?? 0,
					weeks: p.week_count ?? 0,
					marginRate: p.margin_rate ?? 0,
					avgWeeklyQty: p.avg_weekly_qty ?? 0,
				}));
			}),
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

	// Format sales performance context
	const salesContext = salesPerformance.length > 0
		? salesPerformance
			.map((p) => `- ${p.name}: 総売上¥${p.revenue.toLocaleString()}, 粗利率${p.marginRate}%, 週平均${p.avgWeeklyQty}個 (${p.weeks}週間)`)
			.join("\n")
		: "";

	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

	const prompt = `You are a Japan home shopping market expert. Based on REAL search data and actual TV shopping sales performance below, recommend 5 specific products.

Category: ${category}
Target Market: ${targetMarket}
${priceRange ? `Price Range: ${priceRange}` : ""}

=== Real Market Data (from Brave Search) ===
${searchContext || "No search data available — use your market knowledge."}

${salesContext ? `=== 実際のTV通販販売実績データ (2025-2026年) ===\nこのカテゴリで実際に売れている商品の実績です。類似商品や同カテゴリの傾向を参考にしてください。\n${salesContext}\n` : ""}

${existingContext ? `=== High-performing products in our database ===\n${existingContext}\n` : ""}

=== Available Sources (cite relevant ones per product) ===
${allSources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")}

For each recommendation, cite 1-3 source URLs from the list above that support the recommendation.
${salesContext ? "Also consider how the recommendation compares to existing TV shopping bestsellers listed above." : ""}

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

	try {
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
	} catch (err) {
		console.error("[recommend] Gemini or parse error:", err);
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "AI recommendation failed" },
			{ status: 500 },
		);
	}
}
