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
// raw_json は最小形 (research 本体は列に移行済み) — daily-refresh も同形に統一済み
assert(
	!("research" in insert.raw_json) && !("refreshed_at" in insert.raw_json),
	"raw_json stays minimal (no duplicated research body)",
);

// korea_market_fit.fit_score sanitization — generated column が non-integer で NULL 化する
// バグを buildResearchResultInsert が一元的に防ぐ。daily-refresh もこの builder 経由で継承する。
function koreaResearch(fitScore: unknown): ResearchOutput {
	return {
		...research,
		korea_market_fit: {
			fit_score: fitScore,
			target_products: [],
			recommended_channels: [],
		} as unknown as ResearchOutput["korea_market_fit"],
	};
}

const fromString = buildResearchResultInsert("p", productInfo, searchResults, koreaResearch("85点"));
assert(fromString.korea_market_fit?.fit_score === 85, "truncates '85点' → 85");

const fromFloat = buildResearchResultInsert("p", productInfo, searchResults, koreaResearch(72.6));
assert(fromFloat.korea_market_fit?.fit_score === 72, "truncates float 72.6 → 72");

const fromGarbage = buildResearchResultInsert("p", productInfo, searchResults, koreaResearch("n/a"));
assert(fromGarbage.korea_market_fit?.fit_score === null, "non-numeric fit_score → null");

const dirtyResearch = koreaResearch("90点");
buildResearchResultInsert("p", productInfo, searchResults, dirtyResearch);
assert(
	(dirtyResearch.korea_market_fit as { fit_score?: unknown }).fit_score === "90点",
	"does not mutate caller's research object",
);

if (process.exitCode === 1) process.exit(1);
console.log("PASS: research synthesis service helpers");
