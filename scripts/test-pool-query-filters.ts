import assert from "node:assert/strict";
import { __test } from "@/lib/strategy/pool-query";

// Sample rows that the DB layer would have returned (post-query, pre-filter).
type Row = Parameters<typeof __test.applyFilters>[0][number];

function mkRow(overrides: Partial<Row>): Row {
	return {
		id: "r-" + Math.random().toString(36).slice(2, 8),
		name: "test product",
		product_url: "https://example.com/" + Math.random(),
		price_jpy: 10000,
		category: "美容・運動",
		seed_keyword: "美容",
		tv_fit_score: 70,
		tv_fit_reason: "test",
		tv_channel_source: null,
		tv_tier: 1,
		context: "home_shopping",
		user_action: null,
		c_package: null,
		enrichment_status: "idle",
		review_count: 50,
		review_avg: 4.2,
		seller_name: "test shop",
		broadcast_tag: "unknown",
		thumbnail_url: null,
		created_at: new Date().toISOString(),
		...overrides,
	};
}

// --- R2: rejected/duplicate 제외 ---
{
	const rows = [
		mkRow({ id: "a", user_action: "rejected" }),
		mkRow({ id: "b", user_action: "duplicate" }),
		mkRow({ id: "c", user_action: "sourced" }),
		mkRow({ id: "d", user_action: null }),
	];
	const out = __test.applyFilters(rows, { context: "home_shopping" });
	assert.deepEqual(out.map((r) => r.id).sort(), ["c", "d"], "R2: rejected/duplicate excluded");
}

// --- R4: 카테고리 substring 매치 — discovered_products.category 또는 seed_keyword ---
{
	const rows = [
		mkRow({ id: "cat-hit", category: "美容・運動 > スキンケア", seed_keyword: "保湿" }),
		mkRow({ id: "kw-hit", category: "その他", seed_keyword: "美容ケア用品" }),
		mkRow({ id: "miss", category: "食品", seed_keyword: "おかず" }),
		mkRow({ id: "miss2", category: "食品", seed_keyword: "おかず2" }),
		mkRow({ id: "miss3", category: "食品", seed_keyword: "おかず3" }),
		mkRow({ id: "miss4", category: "食品", seed_keyword: "おかず4" }),
		mkRow({ id: "miss5", category: "食品", seed_keyword: "おかず5" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		uiCategory: "美容・スキンケア",
	});
	assert.deepEqual(out.map((r) => r.id).sort(), ["cat-hit", "kw-hit"], "R4: category fuzzy match");
}

// --- R4 fail-open: 결과가 5개 미만이면 카테고리 필터 무시 ---
{
	const rows = [
		mkRow({ id: "hit", category: "美容・運動", seed_keyword: "美容" }),
		mkRow({ id: "miss1", category: "食品", seed_keyword: "ご飯" }),
		mkRow({ id: "miss2", category: "食品", seed_keyword: "おかず" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		uiCategory: "美容・スキンケア",
	});
	// Since strict filter yields <5, all rows returned.
	assert.equal(out.length, 3, "R4 fail-open: <5 matches → return all");
}

// --- R5: 가격 필터 ---
{
	const rows = Array.from({ length: 6 }, (_, i) =>
		mkRow({ id: `p-${i}`, price_jpy: 2000 + i * 2000 }), // 2k, 4k, 6k, 8k, 10k, 12k
	);
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		priceRange: { min: 4000, max: 10000 },
	});
	assert.deepEqual(
		out.map((r) => r.price_jpy).sort((a, b) => (a ?? 0) - (b ?? 0)),
		[4000, 6000, 8000, 10000],
		"R5: price range filter",
	);
}

// --- R5 NULL price 통과 ---
{
	const rows = [
		mkRow({ id: "p1", price_jpy: 5000 }),
		mkRow({ id: "p2", price_jpy: null }),
		mkRow({ id: "p3", price_jpy: 5500 }),
		mkRow({ id: "p4", price_jpy: 5800 }),
		mkRow({ id: "p5", price_jpy: 6000 }),
		mkRow({ id: "p6", price_jpy: 6300 }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		priceRange: { min: 5000, max: 6500 },
	});
	assert.ok(out.some((r) => r.id === "p2"), "R5: NULL price passes through");
}

// --- R3: context 필터 ---
{
	const rows = [
		mkRow({ id: "h1", context: "home_shopping" }),
		mkRow({ id: "l1", context: "live_commerce" }),
	];
	const out = __test.applyFilters(rows, { context: "live_commerce" });
	assert.deepEqual(out.map((r) => r.id), ["l1"], "R3: context filter");
}

console.log("PASS: pool-query filters (R2/R3/R4/R5)");
