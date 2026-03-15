const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY!;

async function braveSearch(query: string): Promise<string> {
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;

	const res = await fetch(url, {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": BRAVE_API_KEY,
		},
	});

	if (!res.ok) {
		console.error("Brave search failed:", res.status);
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
	];

	// Run searches in parallel
	const results = await Promise.allSettled(
		queries.map(async ({ key, query }) => {
			const result = await braveSearch(query);
			return { key, result };
		}),
	);

	for (const r of results) {
		if (r.status === "fulfilled") {
			searches[r.value.key] = r.value.result;
		}
	}

	return searches;
}
