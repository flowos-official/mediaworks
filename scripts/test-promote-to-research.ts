import assert from "node:assert/strict";
import {
	buildDiscoveryPromotionInsert,
	formatPromotionError,
	PromotionError,
	promotionFeedbackRow,
	type DiscoveredProductForPromotion,
} from "../lib/discovery/promote-to-research";

const discoveredProduct: DiscoveredProductForPromotion = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "実演向け調理家電",
	product_url: "https://item.rakuten.co.jp/sample/product-1/",
	thumbnail_url: "https://image.example/product-1.jpg",
	category: "家電",
	price_jpy: 14800,
	tv_fit_reason: "短時間で調理結果を見せられる",
	enrichment_status: "completed",
	c_package: {
		manufacturer: {
			name: "Sample Factory",
			is_seller_same_as_manufacturer: false,
			official_site: null,
			address: null,
			contact_hints: [],
			confidence: "medium",
		},
		wholesale_estimate: {
			retail_jpy: 14800,
			estimated_cost_jpy: 6800,
			estimated_margin_rate: 0.54,
			method: "baseline",
			sample_size: 1,
			confidence: "medium",
		},
		moq_hint: "100個から相談",
		tv_script_draft: "材料を入れて完成までを見せる実演が強い。",
		sns_trend: { signal_strength: "medium", sources: ["https://example.com/trend"] },
		enriched_at: "2026-05-23T00:00:00.000Z",
		tool_calls_used: 3,
		partial: false,
	},
};

const insert = buildDiscoveryPromotionInsert(discoveredProduct);
assert.equal(insert.name, "実演向け調理家電");
assert.equal(insert.category, "家電");
assert.equal(insert.price_range, "¥14,800");
assert.equal(insert.file_url, "https://item.rakuten.co.jp/sample/product-1/");
assert.equal(insert.file_name, "discovery-11111111-1111-4111-8111-111111111111.url");
assert.equal(insert.status, "extracted");
assert.equal(insert.ingest_source, "discovery_promotion");
assert.equal(insert.discovered_product_id, discoveredProduct.id);
assert.deepEqual(insert.features, [
	"製造元: Sample Factory",
	"MOQ: 100個から相談",
	"卸値推定: ¥6,800",
]);
assert.match(insert.description, /材料を入れて完成まで/);
assert.match(insert.description, /製造元: Sample Factory/);
assert.match(insert.description, /SNS シグナル: medium \(1件\)/);

assert.deepEqual(promotionFeedbackRow(discoveredProduct.id), {
	discovered_product_id: discoveredProduct.id,
	action: "deep_dive",
	reason: "promoted_to_research",
});

const formatted = formatPromotionError(
	new PromotionError(500, "promotion failed", {
		message: "null value in column",
		code: "23502",
		details: "Failing row contains null",
		hint: "Set required fields",
	}),
);
assert.match(formatted, /promotion failed/);
assert.match(formatted, /cause: null value in column/);
assert.match(formatted, /code: 23502/);
assert.match(formatted, /details: Failing row contains null/);
assert.match(formatted, /hint: Set required fields/);

console.log("PASS: discovery promotion helpers");
