import assert from "node:assert/strict";
import {
	buildRecommendationFlowChecks,
	hasStrictFailures,
	summarizeStrictFailures,
	type RecommendationFlowEvidence,
} from "../lib/recommendation/flow-readiness";

const ready: RecommendationFlowEvidence = {
	latestDiscoveryRun: { id: "run-1", context: "home_shopping", status: "completed" },
	latestDiscoveryProductCount: 5,
	contextDiscoveryRuns: [
		{ context: "home_shopping", status: "completed", productCount: 5 },
		{ context: "live_commerce", status: "completed", productCount: 5 },
	],
	promotableCandidate: { id: "dp-1", name: "候補商品" },
	promotedProduct: { id: "p-1", name: "昇格商品", status: "completed", discovered_product_id: "dp-1" },
	promotedResearchResult: { product_id: "p-1" },
	latestMdStrategy: { id: "strategy-1", user_goal: "月商500万" },
	integratedMdStrategy: {
		id: "strategy-1",
		user_goal: "月商500万",
		internalProductCount: 3,
		externalCandidateCount: 2,
		poolSources: ["discovery_pool", "fresh_search"],
		poolSourceCounts: [
			{ source: "discovery_pool", count: 1 },
			{ source: "fresh_search", count: 1 },
		],
		discoveryPoolCount: 1,
		freshSearchCount: 1,
		researchCandidateCount: 0,
		tvSignalCount: 1,
		discoveredProductIds: ["dp-1"],
	},
	latestLinkedScreenplay: { id: "sp-1", product_id: "p-1", status: "ready" },
	promotedLinkedScreenplay: { id: "sp-1", product_id: "p-1", status: "ready" },
	dataCoverage: {
		categoryNormalization: {
			discoveredRawCategoryCount: 10,
			coveredRawCategoryCount: 10,
			normalizedRawCategoryCount: 10,
			missingRawCategoryCount: 0,
			cacheCoveragePct: 100,
		},
		broadcastCategories: {
			broadcastsTotal: 10,
			broadcastsWithCategory: 10,
			historicalTotal: 0,
			historicalWithCategory: 0,
			overallCoveragePct: 100,
		},
		operatorFitCategories: {
			total: 0,
			withCategory: 0,
			coveragePct: 0,
		},
	},
};

const readyChecks = buildRecommendationFlowChecks(ready);
assert.equal(hasStrictFailures(readyChecks), false);
assert.equal(summarizeStrictFailures(readyChecks), "");
assert.ok(
	readyChecks.some((check) => check.key === "category_normalization_cache" && check.status === "pass"),
);

const missingPromotion: RecommendationFlowEvidence = {
	...ready,
	promotedProduct: null,
	promotedResearchResult: null,
	promotedLinkedScreenplay: null,
};

const missingPromotionChecks = buildRecommendationFlowChecks(missingPromotion);
assert.equal(hasStrictFailures(missingPromotionChecks), true);
assert.match(
	summarizeStrictFailures(missingPromotionChecks),
	/Discovery 후보가 Research 상품으로 승격되지 않음/,
);
assert.match(
	summarizeStrictFailures(missingPromotionChecks),
	/npx tsx --env-file=.env.local scripts\/promote-discovered-to-research.ts --id=dp-1 --apply/,
);

const missingResearch: RecommendationFlowEvidence = {
	...ready,
	promotedProduct: { id: "p-1", name: "昇格商品", status: "extracted", discovered_product_id: "dp-1" },
	promotedResearchResult: null,
	promotedLinkedScreenplay: null,
};

const missingResearchChecks = buildRecommendationFlowChecks(missingResearch);
assert.equal(hasStrictFailures(missingResearchChecks), true);
assert.match(summarizeStrictFailures(missingResearchChecks), /Research 결과가 아직 없음/);

const screenplayGenerating: RecommendationFlowEvidence = {
	...ready,
	latestLinkedScreenplay: { id: "sp-1", product_id: "p-1", status: "generating" },
	promotedLinkedScreenplay: { id: "sp-1", product_id: "p-1", status: "generating" },
};
const screenplayGeneratingChecks = buildRecommendationFlowChecks(screenplayGenerating);
assert.equal(hasStrictFailures(screenplayGeneratingChecks), true);
assert.match(
	summarizeStrictFailures(screenplayGeneratingChecks),
	/승격 상품 연결 screenplay가 ready 상태가 아님/,
);

const missingIntegratedStrategy: RecommendationFlowEvidence = {
	...ready,
	integratedMdStrategy: null,
};
const missingIntegratedStrategyChecks = buildRecommendationFlowChecks(missingIntegratedStrategy);
assert.equal(hasStrictFailures(missingIntegratedStrategyChecks), true);
assert.match(
	summarizeStrictFailures(missingIntegratedStrategyChecks),
	/내부 실적과 Discovery pool 외부 후보를 함께 포함한 MD Strategy/,
);

const failedHomeDiscovery: RecommendationFlowEvidence = {
	...ready,
	contextDiscoveryRuns: [
		{ context: "home_shopping", status: "failed", productCount: 0 },
		{ context: "live_commerce", status: "completed", productCount: 5 },
	],
};
const failedHomeDiscoveryChecks = buildRecommendationFlowChecks(failedHomeDiscovery);
assert.equal(hasStrictFailures(failedHomeDiscoveryChecks), true);
assert.match(
	summarizeStrictFailures(failedHomeDiscoveryChecks),
	/home_shopping Discovery run이 완료 상태가 아니거나 후보가 없음/,
);

console.log("PASS: recommendation flow readiness helpers");
