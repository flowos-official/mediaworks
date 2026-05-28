import assert from "node:assert/strict";
import {
	normalizeDiscoverIntent,
	ensureDiscoverIntent,
	deriveIntentKeywords,
	buildIntentSearchQueries,
	formatIntentPromptSection,
} from "@/lib/strategy/discover-intent";

// --- normalizeDiscoverIntent: bad input → empty defaults ---
{
	const out = normalizeDiscoverIntent(null);
	assert.deepEqual(out.seasonal_keywords, [], "null → empty");
	assert.deepEqual(out.theme_keywords, []);
	assert.deepEqual(out.category_hints, []);
	assert.deepEqual(out.excluded_themes, []);
}

// --- normalizeDiscoverIntent: dedupe + trim + length cap ---
{
	const out = normalizeDiscoverIntent({
		seasonal_keywords: ["冬", " 冬 ", "冬", "年末", ""],
		theme_keywords: ["暖かい", "暖かい", " 防寒"],
		category_hints: [123, "暖房家電", null, "暖房家電"],
		excluded_themes: ["扇風機"],
	});
	assert.deepEqual(out.seasonal_keywords, ["冬", "年末"]);
	assert.deepEqual(out.theme_keywords, ["暖かい", "防寒"]);
	assert.deepEqual(out.category_hints, ["暖房家電"]);
	assert.deepEqual(out.excluded_themes, ["扇風機"]);
}

// --- ensureDiscoverIntent: LLM empty + raw goal contains season → fallback ---
{
	const out = ensureDiscoverIntent(null, "冬に売れる商品を探して");
	assert.ok(out.seasonal_keywords.includes("冬"), "fallback extracts 冬");
}

// --- ensureDiscoverIntent: LLM provided fields → no fallback ---
{
	const out = ensureDiscoverIntent(
		{
			seasonal_keywords: ["夏"],
			theme_keywords: [],
			category_hints: [],
			excluded_themes: [],
			intent_tier: "broad",
			channel_scope: [],
			specific_keyword: null,
		},
		"冬の商品",
	);
	assert.deepEqual(out.seasonal_keywords, ["夏"], "respects LLM output, no override");
}

// --- ensureDiscoverIntent: no raw goal + no fields → empty ---
{
	const out = ensureDiscoverIntent(null, null);
	assert.deepEqual(out.seasonal_keywords, []);
}

// --- deriveIntentKeywords: merges + dedupes + caps at 12 + excludes excluded_themes ---
{
	const kws = deriveIntentKeywords({
		seasonal_keywords: ["冬", "年末"],
		theme_keywords: ["暖かい", "ギフト"],
		category_hints: ["暖房家電", "加湿器"],
		excluded_themes: ["扇風機"], // should NOT appear in pool keywords
		intent_tier: "broad",
		channel_scope: [],
		specific_keyword: null,
	});
	assert.ok(kws.includes("冬"));
	assert.ok(kws.includes("暖房家電"));
	assert.ok(!kws.includes("扇風機"), "excluded_themes not in pool keywords");
}

// --- deriveIntentKeywords: null/undefined → [] ---
{
	assert.deepEqual(deriveIntentKeywords(null), []);
	assert.deepEqual(deriveIntentKeywords(undefined), []);
}

// --- buildIntentSearchQueries: season × category composition ---
{
	const queries = buildIntentSearchQueries({
		seasonal_keywords: ["冬"],
		theme_keywords: ["暖かい"],
		category_hints: ["暖房家電", "加湿器"],
		excluded_themes: [],
		intent_tier: "broad",
		channel_scope: [],
		specific_keyword: null,
	});
	assert.ok(queries.includes("冬 暖房家電"), "season × category combo");
	assert.ok(queries.includes("冬 加湿器"));
	assert.ok(queries.length <= 4, "respects maxQueries default");
}

// --- buildIntentSearchQueries: no season → fall back to bare category hints ---
{
	const queries = buildIntentSearchQueries({
		seasonal_keywords: [],
		theme_keywords: [],
		category_hints: ["美容家電"],
		excluded_themes: [],
		intent_tier: "broad",
		channel_scope: [],
		specific_keyword: null,
	});
	assert.deepEqual(queries, ["美容家電"]);
}

// --- buildIntentSearchQueries: completely empty → [] ---
{
	assert.deepEqual(
		buildIntentSearchQueries({
			seasonal_keywords: [],
			theme_keywords: [],
			category_hints: [],
			excluded_themes: [],
			intent_tier: "broad",
			channel_scope: [],
			specific_keyword: null,
		}),
		[],
	);
	assert.deepEqual(buildIntentSearchQueries(undefined), []);
}

// --- formatIntentPromptSection: empty intent → empty string ---
{
	const out = formatIntentPromptSection({
		seasonal_keywords: [],
		theme_keywords: [],
		category_hints: [],
		excluded_themes: [],
		intent_tier: "broad",
		channel_scope: [],
		specific_keyword: null,
	});
	assert.equal(out, "");
}

// --- formatIntentPromptSection: emits each populated field + raw goal ---
{
	const out = formatIntentPromptSection(
		{
			seasonal_keywords: ["冬"],
			theme_keywords: ["暖かい"],
			category_hints: ["暖房家電"],
			excluded_themes: ["扇風機"],
			intent_tier: "broad",
			channel_scope: [],
			specific_keyword: null,
		},
		"冬に売れる商品を探して",
	);
	assert.ok(out.includes("ユーザー意図"), "has header");
	assert.ok(out.includes("冬"));
	assert.ok(out.includes("暖かい"));
	assert.ok(out.includes("暖房家電"));
	assert.ok(out.includes("扇風機"));
	assert.ok(out.includes("冬に売れる商品を探して"), "includes raw goal");
	assert.ok(out.includes("除外"), "has exclude instruction");
}

console.log("PASS: discover-intent helpers");
