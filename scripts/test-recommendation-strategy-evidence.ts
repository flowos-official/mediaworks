import assert from "node:assert/strict";
import {
	hasIntegratedStrategyEvidence,
	summarizeMdStrategyEvidence,
} from "../lib/recommendation/strategy-evidence";

const integrated = summarizeMdStrategyEvidence({
	id: "strategy-1",
	user_goal: "月商500万",
	product_selection: {
		channel_product_matrix: [
			{
				tier1_products: [{ code: "ITEM-001", name: "既存売れ筋" }],
				tier2_products: [{ code: "ITEM-002", name: "準主力" }],
			},
		],
		discovered_new_products: [
			{
				name: "発掘候補",
				pool_source: "discovery_pool",
				discovered_product_id: "dp-1",
				source: "tv_channel",
				tv_channel_source: "qvc",
				tv_evidence: { airing_count: 3 },
			},
			{ name: "検索候補", pool_source: "fresh_search", signal_basis: "TV通販カテゴリと一致" },
			{ name: "リサーチ候補", pool_source: "research" },
		],
	},
});

assert.equal(integrated.internalProductCount, 2);
assert.equal(integrated.externalCandidateCount, 3);
assert.deepEqual(integrated.poolSources, ["discovery_pool", "fresh_search", "research"]);
assert.deepEqual(integrated.poolSourceCounts, [
	{ source: "discovery_pool", count: 1 },
	{ source: "fresh_search", count: 1 },
	{ source: "research", count: 1 },
]);
assert.equal(integrated.discoveryPoolCount, 1);
assert.equal(integrated.freshSearchCount, 1);
assert.equal(integrated.researchCandidateCount, 1);
assert.equal(integrated.tvSignalCount, 2);
assert.deepEqual(integrated.discoveredProductIds, ["dp-1"]);
assert.equal(hasIntegratedStrategyEvidence(integrated), true);

const internalOnly = summarizeMdStrategyEvidence({
	id: "strategy-2",
	user_goal: "既存品だけ",
	product_selection: {
		channel_product_matrix: [{ tier1_products: [{ code: "ITEM-001" }] }],
		discovered_new_products: [],
	},
});
assert.equal(internalOnly.internalProductCount, 1);
assert.equal(internalOnly.externalCandidateCount, 0);
assert.equal(hasIntegratedStrategyEvidence(internalOnly), false);

const freshSearchOnly = summarizeMdStrategyEvidence({
	id: "strategy-3",
	user_goal: "検索だけ",
	product_selection: {
		channel_product_matrix: [{ tier1_products: [{ code: "ITEM-001" }] }],
		discovered_new_products: [
			{ name: "検索候補", pool_source: "fresh_search" },
		],
	},
});
assert.equal(freshSearchOnly.internalProductCount, 1);
assert.equal(freshSearchOnly.externalCandidateCount, 1);
assert.deepEqual(freshSearchOnly.discoveredProductIds, []);
assert.equal(hasIntegratedStrategyEvidence(freshSearchOnly), false);

console.log("PASS: recommendation strategy evidence helpers");
