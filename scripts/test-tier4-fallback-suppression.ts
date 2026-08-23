import { discoverNewProducts } from "@/lib/md-strategy";

const tier4Input = {
	context: "home_shopping" as const,
	explicitCategory: undefined,
	topCategoryNames: [],
	tvMarginRate: 30,
	tvProductNames: [],
	excludeUrls: [],
	excludeNames: [],
	intent: {
		seasonal_keywords: [],
		theme_keywords: [],
		category_hints: [],
		excluded_themes: [],
		intent_tier: "specific_keyword" as const,
		channel_scope: [],
		specific_keyword: {
			raw: "zzzunlikelyxxx",
			normalized: "zzzunlikelyxxx",
			aliases: [],
			confidence: 0.95,
		},
	},
	lightweight: true,
};

async function main() {
	const result = await discoverNewProducts(tier4Input);
	if (result && result.length > 0) {
		const padded = result.some(
			(r) => ("keyword" in r && r.keyword === "fallback") || /人気商品|売れ筋|おすすめ/.test(r.name ?? ""),
		);
		if (padded) throw new Error(`tier=specific_keyword should suppress broadened fallback`);
	}
	console.log("✓ tier4-fallback-suppression test passes (empty/non-broadened result)");
}
main().catch((e) => { console.error(e); process.exit(1); });
