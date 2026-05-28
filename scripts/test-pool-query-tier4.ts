import { __test } from "@/lib/strategy/pool-query";

const rows = [
	{ name: "三徳包丁 鋼", category: "キッチン用品", context: "home_shopping", user_action: null, id: "1", product_url: "u", price_jpy: 5000, seed_keyword: "包丁", source: "rakuten", tv_fit_score: 50, tv_fit_reason: null, tv_channel_source: null, tv_tier: 1, c_package: null, enrichment_status: "idle", review_count: null, review_avg: null, seller_name: null, broadcast_tag: null, thumbnail_url: null, created_at: "2026-01-01", tv_evidence: null } as any,
	{ name: "ナイフ研ぎ器", category: "キッチン用品", context: "home_shopping", user_action: null, id: "2", product_url: "u", price_jpy: 3000, seed_keyword: "ナイフ", source: "rakuten", tv_fit_score: 50, tv_fit_reason: null, tv_channel_source: null, tv_tier: 1, c_package: null, enrichment_status: "idle", review_count: null, review_avg: null, seller_name: null, broadcast_tag: null, thumbnail_url: null, created_at: "2026-01-01", tv_evidence: null } as any,
	{ name: "電気ストーブ", category: "家電・雑貨", context: "home_shopping", user_action: null, id: "3", product_url: "u", price_jpy: 8000, seed_keyword: "暖房", source: "rakuten", tv_fit_score: 50, tv_fit_reason: null, tv_channel_source: null, tv_tier: 1, c_package: null, enrichment_status: "idle", review_count: null, review_avg: null, seller_name: null, broadcast_tag: null, thumbnail_url: null, created_at: "2026-01-01", tv_evidence: null } as any,
	{ name: "保温マグ", category: "キッチン用品", context: "home_shopping", user_action: null, id: "4", product_url: "u", price_jpy: 2000, seed_keyword: "マグ", source: "rakuten", tv_fit_score: 50, tv_fit_reason: null, tv_channel_source: null, tv_tier: 1, c_package: null, enrichment_status: "idle", review_count: null, review_avg: null, seller_name: null, broadcast_tag: null, thumbnail_url: null, created_at: "2026-01-01", tv_evidence: null } as any,
];

// Tier 4: only items containing "包丁" or "ナイフ" pass
const r1 = __test.applyFilters(rows, {
	context: "home_shopping",
	intentTier: "specific_keyword",
	specificKeyword: "包丁",
	specificAliases: ["ナイフ"],
});

if (r1.length !== 2) throw new Error(`expected 2 knives, got ${r1.length}: ${r1.map((x) => x.name)}`);
if (!r1.some((x) => x.name.includes("包丁"))) throw new Error("包丁 not found");
if (!r1.some((x) => x.name.includes("ナイフ"))) throw new Error("ナイフ not found");

// Single match (below R4.5 fail-open threshold) should still return 1, not fall back
const r2 = __test.applyFilters([rows[0], rows[2], rows[3]], {
	context: "home_shopping",
	intentTier: "specific_keyword",
	specificKeyword: "包丁",
	specificAliases: [],
});
if (r2.length !== 1) throw new Error(`fail-open should be OFF for tier 4; expected 1, got ${r2.length}`);

console.log("✓ pool-query-tier4 tests pass");
