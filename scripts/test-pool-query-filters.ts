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
		tv_evidence: null,
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

// --- R5 NULL price 통과 + 범위 외 제외 ---
{
	const rows = [
		mkRow({ id: "p1", price_jpy: 5000 }),
		mkRow({ id: "p2", price_jpy: null }),
		mkRow({ id: "p3", price_jpy: 5500 }),
		mkRow({ id: "p4", price_jpy: 5800 }),
		mkRow({ id: "p5", price_jpy: 6000 }),
		mkRow({ id: "p6", price_jpy: 6300 }),
		mkRow({ id: "p7", price_jpy: 9000 }), // out of range
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		priceRange: { min: 5000, max: 6500 },
	});
	assert.ok(out.some((r) => r.id === "p2"), "R5: NULL price passes through");
	assert.ok(!out.some((r) => r.id === "p7"), "R5: out-of-range row excluded");
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

// --- R4.5: intent keyword fuzzy match across name/category/seed_keyword/tv_fit_reason ---
// (need ≥5 matches so fail-open does NOT kick in; here we have 5 hits + 3 miss)
{
	const rows = [
		mkRow({ id: "name-hit", name: "冬用ホットカーペット 3畳", category: "家電", seed_keyword: "カーペット", tv_fit_reason: "シニア層に人気" }),
		mkRow({ id: "cat-hit", name: "毛布シングル", category: "防寒寝具", seed_keyword: "毛布", tv_fit_reason: "実演デモ向き" }),
		mkRow({ id: "kw-hit", name: "電気ケトル", category: "キッチン", seed_keyword: "暖かい飲み物", tv_fit_reason: "通年" }),
		mkRow({ id: "reason-hit", name: "ストレッチマット", category: "健康", seed_keyword: "運動", tv_fit_reason: "冬場の運動不足解消" }),
		mkRow({ id: "name-hit-2", name: "電気毛布", category: "寝具", seed_keyword: "毛布", tv_fit_reason: "冬の必需品" }),
		mkRow({ id: "miss-1", name: "扇風機", category: "家電", seed_keyword: "夏物", tv_fit_reason: "夏季限定" }),
		mkRow({ id: "miss-2", name: "クーラーボックス", category: "アウトドア", seed_keyword: "夏レジャー", tv_fit_reason: "海" }),
		mkRow({ id: "miss-3", name: "鼻専用美顔器", category: "美容", seed_keyword: "美容ケア", tv_fit_reason: "通年" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		intentKeywords: ["冬", "防寒", "暖かい"],
	});
	const ids = out.map((r) => r.id).sort();
	assert.deepEqual(
		ids,
		["cat-hit", "kw-hit", "name-hit", "name-hit-2", "reason-hit"],
		"R4.5: intent fuzzy match across name+category+seed_keyword+tv_fit_reason",
	);
}

// --- R4.5 case-insensitive (need ≥5 matches to avoid fail-open) ---
{
	const rows = [
		mkRow({ id: "a", name: "Winter Coat", category: "アパレル", seed_keyword: "コート", tv_fit_reason: "—" }),
		mkRow({ id: "b", name: "暖房ヒーター 強力", category: "家電", seed_keyword: "暖房", tv_fit_reason: "—" }),
		mkRow({ id: "c", name: "WINTER GIFT BOX", category: "ギフト", seed_keyword: "プレゼント", tv_fit_reason: "—" }),
		mkRow({ id: "d-hit", name: "Winter Boots", category: "シューズ", seed_keyword: "ブーツ", tv_fit_reason: "—" }),
		mkRow({ id: "e-hit", name: "床暖房マット", category: "家電", seed_keyword: "床暖房", tv_fit_reason: "—" }),
		mkRow({ id: "f", name: "通年商品3", category: "雑貨", seed_keyword: "日用品", tv_fit_reason: "—" }),
		mkRow({ id: "g", name: "通年商品4", category: "雑貨", seed_keyword: "日用品", tv_fit_reason: "—" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		intentKeywords: ["winter", "暖房"],
	});
	const ids = out.map((r) => r.id).sort();
	assert.deepEqual(
		ids,
		["a", "b", "c", "d-hit", "e-hit"],
		"R4.5: case-insensitive substring match",
	);
}

// --- R4.5 fail-open: 결과가 5개 미만이면 intent 필터 무시 ---
{
	const rows = [
		mkRow({ id: "hit", name: "ホットカーペット 冬", category: "家電", seed_keyword: "カーペット", tv_fit_reason: "—" }),
		mkRow({ id: "miss-1", name: "通年商品1", category: "雑貨", seed_keyword: "日用品", tv_fit_reason: "—" }),
		mkRow({ id: "miss-2", name: "通年商品2", category: "雑貨", seed_keyword: "日用品", tv_fit_reason: "—" }),
		mkRow({ id: "miss-3", name: "通年商品3", category: "雑貨", seed_keyword: "日用品", tv_fit_reason: "—" }),
		mkRow({ id: "miss-4", name: "通年商品4", category: "雑貨", seed_keyword: "日用品", tv_fit_reason: "—" }),
		mkRow({ id: "miss-5", name: "通年商品5", category: "雑貨", seed_keyword: "日用品", tv_fit_reason: "—" }),
		mkRow({ id: "miss-6", name: "通年商品6", category: "雑貨", seed_keyword: "日用品", tv_fit_reason: "—" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		intentKeywords: ["冬"],
	});
	// Strict match = 1 row (< FAIL_OPEN_THRESHOLD=5), so all 7 rows returned.
	assert.equal(out.length, 7, "R4.5 fail-open: <5 intent matches → return all");
}

// --- R4.5 empty intentKeywords = no-op ---
{
	const rows = [
		mkRow({ id: "a" }),
		mkRow({ id: "b" }),
		mkRow({ id: "c" }),
		mkRow({ id: "d" }),
		mkRow({ id: "e" }),
		mkRow({ id: "f" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		intentKeywords: [],
	});
	assert.equal(out.length, 6, "R4.5: empty intentKeywords leaves rows untouched");
}

// --- R4.5 + R4 composition: intent narrows category result correctly ---
{
	const rows = [
		mkRow({ id: "win-1", name: "冬用ホットカーペット", category: "家電・家具", seed_keyword: "暖房", tv_fit_reason: "—" }),
		mkRow({ id: "win-2", name: "冬の鍋セット", category: "家電・家具", seed_keyword: "キッチン", tv_fit_reason: "—" }),
		mkRow({ id: "no-season", name: "炊飯器", category: "家電・家具", seed_keyword: "炊飯", tv_fit_reason: "—" }),
		mkRow({ id: "no-season-2", name: "電子レンジ", category: "家電・家具", seed_keyword: "調理", tv_fit_reason: "—" }),
		mkRow({ id: "no-season-3", name: "掃除機", category: "家電・家具", seed_keyword: "掃除", tv_fit_reason: "—" }),
		mkRow({ id: "no-season-4", name: "オーブン", category: "家電・家具", seed_keyword: "調理", tv_fit_reason: "—" }),
		mkRow({ id: "no-season-5", name: "冷蔵庫", category: "家電・家具", seed_keyword: "冷蔵", tv_fit_reason: "—" }),
		mkRow({ id: "off-cat", name: "美顔器", category: "美容", seed_keyword: "美容", tv_fit_reason: "—" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		uiCategory: "家電・家具",
		intentKeywords: ["冬"],
	});
	// R4 keeps the 7 家電 rows; R4.5 narrows to 2 "冬" hits — but 2 < 5 → fail-open → R4 result.
	assert.equal(out.length, 7, "R4.5 fail-open under R4: keeps R4 result when intent shrinks below threshold");
}

console.log("PASS: pool-query filters (R2/R3/R4/R4.5/R5)");
