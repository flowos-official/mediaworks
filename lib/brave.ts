import { rakutenRankingSearch, formatRakutenRanking } from "@/lib/rakuten";
const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

async function braveSearch(query: string): Promise<string> {
	if (!BRAVE_API_KEY) {
		return "Search unavailable (no API key)";
	}

	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;

	const res = await fetch(url, {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": BRAVE_API_KEY,
		},
		signal: AbortSignal.timeout(10000),
	});

	if (!res.ok) {
		// 402 = quota exhausted, fall back gracefully
		console.warn(`Brave search failed: ${res.status} — using Gemini-only analysis`);
		return "Search unavailable";
	}

	const data = await res.json();
	const results = data.web?.results || [];

	return results
		.slice(0, 5)
		.map(
			(r: { title: string; description?: string; url: string }) =>
				`Title: ${r.title}\nDescription: ${r.description || ""}\nURL: ${r.url}`,
		)
		.join("\n\n");
}

export async function runProductResearch(
	productName: string,
	productCategory: string,
): Promise<Record<string, string>> {
	const searches: Record<string, string> = {};

	const queries = [
		{
			key: "market_overview",
			query: `${productName} ${productCategory} home shopping market trends 2024`,
		},
		{
			key: "target_demographics",
			query: `${productName} target audience demographics consumer profile`,
		},
		{
			key: "seasonality",
			query: `${productName} ${productCategory} seasonal demand peak sales months`,
		},
		{
			key: "cogs_alibaba",
			query: `${productName} wholesale price alibaba supplier cost`,
		},
		{
			key: "influencers",
			query: `${productName} ${productCategory} influencer marketing instagram youtube`,
		},
		{
			key: "content_marketing",
			query: `${productName} ${productCategory} content marketing ideas social media strategy`,
		},
		// Japan market queries
		{
			key: "japan_market",
			query: `${productName} 日本 ホームショッピング 市場`,
		},
		{
			key: "japan_price",
			query: `${productName} 楽天 価格帯 相場`,
		},
		{
			key: "japan_reviews",
			query: `${productName} Amazon Japan レビュー 評価`,
		},
		// TV shopping specific queries
		{
			key: "tv_shopping_hit_products",
			query: `${productCategory} テレビ通販 ヒット商品 売れ筋 2024 2025`,
		},
		{
			key: "tv_shopping_similar",
			query: `${productName} ${productCategory} ショップチャンネル QVC 日テレポシュレ 通販`,
		},
		{
			key: "tv_shopping_viewer_demographics",
			query: `テレビ通販 視聴者 購買層 年齢 ${productCategory}`,
		},
		{
			key: "tv_shopping_market_data",
			query: `${productCategory} テレビショッピング 市場規模 売上 通販新聞`,
		},
	];

	// Run Brave searches + Rakuten ranking in parallel
	const [braveResults, rakutenResult] = await Promise.all([
		Promise.allSettled(
			queries.map(async ({ key, query }) => {
				const result = await braveSearch(query);
				return { key, result };
			}),
		),
		rakutenRankingSearch(productName).catch(() => ({ items: [] })),
	]);

	for (const r of braveResults) {
		if (r.status === "fulfilled") {
			searches[r.value.key] = r.value.result;
		}
	}

	// Add Rakuten ranking data if available
	const rakutenFormatted = formatRakutenRanking(rakutenResult);
	if (rakutenFormatted) {
		searches["rakuten_ranking"] = rakutenFormatted;
	}

	return searches;
}

export type BraveWebResult = {
	title: string;
	description: string;
	url: string;
};

/**
 * Structured Brave Web Search returning parsed result objects (vs. formatted string).
 * Used by discovery pool builder.
 */
export async function braveSearchItems(
	query: string,
	count = 10,
): Promise<BraveWebResult[]> {
	if (!BRAVE_API_KEY) return [];

	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;

	try {
		const res = await fetch(url, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": BRAVE_API_KEY,
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			console.warn(`[brave items] ${res.status}`);
			return [];
		}
		const data = await res.json();
		const results: Array<{ title?: string; description?: string; url?: string }> =
			data.web?.results ?? [];
		return results.map((r) => ({
			title: r.title ?? "",
			description: r.description ?? "",
			url: r.url ?? "",
		}));
	} catch (err) {
		console.warn(
			"[brave items] fetch failed:",
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}
