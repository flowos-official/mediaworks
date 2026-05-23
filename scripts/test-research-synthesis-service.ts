import type { ResearchOutput } from "../lib/gemini";
import {
	buildProductInfoFromProductRow,
	buildResearchResultInsert,
} from "../lib/research/synthesize-product";

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`PASS: ${message}`);
	}
}

const productInfo = buildProductInfoFromProductRow({
	name: null,
	description: null,
	features: ["steam demo", "", 42, "compact"] as unknown[],
	category: null,
	price_range: null,
	target_market: "TV shoppers",
});

assert(productInfo.name === "Unknown Product", "defaults missing product name");
assert(productInfo.description === "", "defaults missing description");
assert(productInfo.category === "General", "defaults missing category");
assert(productInfo.price_range === undefined, "omits null price range");
assert(productInfo.target_market === "TV shoppers", "keeps target market");
assert(productInfo.features.join("|") === "steam demo|compact", "normalizes feature list");

const research: ResearchOutput = {
	marketability_score: 82,
	marketability_description: "Strong TV fit.",
	demographics: {
		age_group: "50代以上",
		gender: "女性中心",
		interests: ["home shopping"],
		income_level: "middle",
	},
	seasonality: { jan: 80 },
	cogs_estimate: { items: [], summary: "sample" },
	influencers: [],
	content_ideas: [],
	competitor_analysis: [],
	recommended_price_range: "JPY 9,800",
	broadcast_scripts: {
		sec30: "short",
		sec60: "medium",
		min5: "long",
	},
	japan_export_fit_score: 76,
};

const searchResults = { market: "source result" };
const insert = buildResearchResultInsert("product-1", productInfo, searchResults, research);

assert(insert.product_id === "product-1", "sets product id");
assert(insert.marketability_score === 82, "sets research score");
assert(insert.raw_json.product_info === productInfo, "keeps product info snapshot");
assert(insert.raw_json.search_results === searchResults, "keeps search result snapshot");
assert(insert.raw_json.research === research, "keeps research snapshot");

if (process.exitCode === 1) process.exit(1);
console.log("PASS: research synthesis service helpers");
