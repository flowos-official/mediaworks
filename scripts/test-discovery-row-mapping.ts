import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/save";
import type { Candidate } from "@/lib/discovery/types";

const candidate: Candidate = {
	name: "Test Product",
	productUrl: "https://item.rakuten.co.jp/test-shop/test-item/",
	thumbnailUrl: "https://example.com/thumb.jpg",
	priceJpy: 12800,
	category: "Drying Appliances",
	reviewCount: 120,
	reviewAvg: 4.7,
	sellerName: "Test Shop",
	stockStatus: "in_stock",
	source: "rakuten",
	rakutenItemCode: "test-shop:test-item",
	seedKeyword: "布団 乾燥機 ハイパワー",
	track: "tv_proven",
	tvChannelSource: "qvc,shopch",
	context: "home_shopping",
	tvFitScore: 95,
	tvFitReason: "実演しやすくレビューも強い",
	isTvApplicable: true,
	isLiveApplicable: true,
	scoreBreakdown: {
		review_signal: 30,
		tv_category_match: 20,
		trend_signal: 15,
		price_fit: 15,
		purchase_signal: 15,
		total: 95,
	},
};

const rows = __test.buildDiscoveredProductRows("session-1", [
	{
		candidate,
		broadcastTag: "broadcast_confirmed",
		broadcastSources: [{ title: "source", url: "https://example.com" }],
	},
]);

assert.equal(rows.length, 1);
assert.equal(rows[0].category, "Drying Appliances");
assert.equal(rows[0].seed_keyword, "布団 乾燥機 ハイパワー");
assert.notEqual(rows[0].category, rows[0].seed_keyword);
assert.equal(rows[0].tv_channel_source, "qvc,shopch");

console.log("PASS: discovery row mapping keeps category and seed_keyword separate");
