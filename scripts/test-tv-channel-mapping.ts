import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/curate";
import type { PoolItem } from "@/lib/discovery/types";

const poolItem: PoolItem = {
	name: "X",
	productUrl: "https://example.com/x",
	source: "tv_channel",
	seedKeyword: "kw",
	track: "tv_proven",
	tvChannel: "shopch",
	tvChannelMatches: ["shopch", "qvc"],
};

const candidate = __test.poolItemToCandidate(poolItem, {
	tvFitScore: 88,
	tvFitReason: "test",
	isTvApplicable: true,
	isLiveApplicable: false,
	scoreBreakdown: {
		review_signal: 20,
		tv_category_match: 20,
		trend_signal: 15,
		price_fit: 15,
		purchase_signal: 18,
		total: 88,
	},
	context: "home_shopping",
});

assert.equal(candidate.tvChannelSource, "qvc,shopch");
assert.equal(candidate.tvChannel, "shopch");
assert.deepEqual(candidate.tvChannelMatches, ["shopch", "qvc"]);

const noChannel: PoolItem = {
	name: "Y",
	productUrl: "https://example.com/y",
	source: "rakuten",
	seedKeyword: "kw",
	track: "tv_proven",
};
const candidate2 = __test.poolItemToCandidate(noChannel, {
	tvFitScore: 50,
	tvFitReason: "test",
	isTvApplicable: true,
	isLiveApplicable: false,
	scoreBreakdown: {
		review_signal: 10,
		tv_category_match: 10,
		trend_signal: 10,
		price_fit: 10,
		purchase_signal: 10,
		total: 50,
	},
	context: "home_shopping",
});
assert.equal(candidate2.tvChannelSource, null);

console.log("PASS: curate poolItemToCandidate sets tvChannelSource");
