/**
 * Unit tests for `attributeSource` — the post-Gemini source tagging logic
 * extracted from `discoverNewProducts`.
 *
 * Bug context (root cause): Gemini was allowed by the curation prompt to
 * rewrite source URLs (strip tracking params, change formats), so the
 * URL-only match in the inline code at lib/md-strategy.ts:1031-1049 failed
 * for most pool items, mis-tagging them as `fresh_search` and losing the
 * `discovered_product_id` linkage.
 *
 * These tests pin down the expected attribution behavior so we can verify
 * a fix without burning Gemini tokens.
 */

import assert from "node:assert/strict";
import { attributeSource } from "@/lib/strategy/source-attribution";

type GeminiItem = {
	name: string;
	source_url: string;
	other?: string;
};

type PoolItem = {
	name: string;
	source_url: string;
	pool_source: "discovery_pool" | "fresh_search";
	discovered_product_id?: string;
};

function makePool(overrides: Partial<PoolItem>[]): PoolItem[] {
	return overrides.map((o, i) => ({
		name: o.name ?? `pool item ${i}`,
		source_url: o.source_url ?? `https://example.com/pool/${i}`,
		pool_source: o.pool_source ?? "discovery_pool",
		discovered_product_id: o.discovered_product_id ?? `pid-${i}`,
	}));
}

// ── Scenario 1: exact URL match ────────────────────────────────────────────
{
	const pool = makePool([
		{
			source_url: "https://item.rakuten.co.jp/shop-a/12345/",
			name: "商品A",
			discovered_product_id: "pid-a",
		},
	]);
	const items: GeminiItem[] = [
		{ name: "商品A", source_url: "https://item.rakuten.co.jp/shop-a/12345/" },
	];
	const { enriched, stats } = attributeSource(items, pool);
	assert.equal(enriched[0].pool_source, "discovery_pool", "exact URL → pool tag");
	assert.equal(enriched[0].discovered_product_id, "pid-a", "exact URL → ID preserved");
	assert.equal(stats.url, 1, "stats.url counted");
}

// ── Scenario 2: trailing slash variant ─────────────────────────────────────
{
	const pool = makePool([
		{
			source_url: "https://item.rakuten.co.jp/shop-a/12345/",
			discovered_product_id: "pid-a",
		},
	]);
	const items: GeminiItem[] = [
		// Gemini dropped trailing slash
		{ name: "商品A", source_url: "https://item.rakuten.co.jp/shop-a/12345" },
	];
	const { enriched } = attributeSource(items, pool);
	assert.equal(enriched[0].pool_source, "discovery_pool", "trailing slash → match");
	assert.equal(enriched[0].discovered_product_id, "pid-a", "trailing slash → ID");
}

// ── Scenario 3: protocol mismatch ─────────────────────────────────────────
{
	const pool = makePool([
		{
			source_url: "https://item.rakuten.co.jp/shop-a/12345/",
			discovered_product_id: "pid-a",
		},
	]);
	const items: GeminiItem[] = [
		// Gemini downgraded protocol
		{ name: "商品A", source_url: "http://item.rakuten.co.jp/shop-a/12345/" },
	];
	const { enriched } = attributeSource(items, pool);
	assert.equal(enriched[0].pool_source, "discovery_pool", "protocol → match");
	assert.equal(enriched[0].discovered_product_id, "pid-a");
}

// ── Scenario 4: query string stripped (the real bug) ──────────────────────
{
	const pool = makePool([
		{
			source_url: "https://item.rakuten.co.jp/shop-a/12345/?rafcid=abc&scid=xyz",
			discovered_product_id: "pid-a",
		},
	]);
	const items: GeminiItem[] = [
		// Gemini stripped tracking params
		{ name: "商品A", source_url: "https://item.rakuten.co.jp/shop-a/12345/" },
	];
	const { enriched, stats } = attributeSource(items, pool);
	assert.equal(
		enriched[0].pool_source,
		"discovery_pool",
		"query stripped → still matches (itemCode or normalize)",
	);
	assert.equal(enriched[0].discovered_product_id, "pid-a", "ID preserved");
	assert.ok(
		stats.url + stats.itemCode === 1,
		"matched via url or itemCode, not nameFallback",
	);
}

// ── Scenario 5: www. subdomain difference ─────────────────────────────────
{
	const pool = makePool([
		{
			source_url: "https://www.amazon.co.jp/dp/B0XYZ123",
			discovered_product_id: "pid-amz",
		},
	]);
	const items: GeminiItem[] = [
		// Gemini stripped www
		{ name: "商品X", source_url: "https://amazon.co.jp/dp/B0XYZ123" },
	];
	const { enriched } = attributeSource(items, pool);
	assert.equal(enriched[0].pool_source, "discovery_pool", "www → match");
	assert.equal(enriched[0].discovered_product_id, "pid-amz");
}

// ── Scenario 6: Rakuten itemCode rescue when URL differs ──────────────────
{
	const pool = makePool([
		{
			source_url: "https://item.rakuten.co.jp/shop-a/12345/?utm_source=mail",
			discovered_product_id: "pid-a",
		},
	]);
	const items: GeminiItem[] = [
		// Same itemCode (shop-a:12345) but Gemini rewrote with different shape
		{
			name: "商品A",
			source_url: "https://item.rakuten.co.jp/shop-a/12345/index.html",
		},
	];
	const { enriched, stats } = attributeSource(items, pool);
	assert.equal(enriched[0].pool_source, "discovery_pool", "itemCode rescue");
	assert.equal(enriched[0].discovered_product_id, "pid-a", "ID preserved via itemCode");
	assert.ok(stats.itemCode >= 1, "stats.itemCode counted");
}

// ── Scenario 7: name-only fallback (pool_source restored, ID withheld) ────
// CRITICAL: this is the false-positive guard. Name matching alone is NOT
// strong enough to safely link discovered_product_id (UI would show wrong
// c_package / tv_evidence). So pool_source is restored but ID is undefined.
{
	const pool = makePool([
		{
			name: "ドクターエア 3D エアストレッチマット",
			source_url: "https://example.com/shop-pool/specific-url-only-in-pool",
			discovered_product_id: "pid-stretch",
		},
	]);
	const items: GeminiItem[] = [
		// Same product name (so we know it's in the pool conceptually),
		// but Gemini fabricated a completely different URL with no itemCode
		// link back to the pool.
		{
			name: "ドクターエア 3D エアストレッチマット",
			source_url: "https://shopping.example.org/gemini-fabricated/abc",
		},
	];
	const { enriched, stats } = attributeSource(items, pool);
	assert.equal(
		enriched[0].pool_source,
		"discovery_pool",
		"name fallback restores pool_source",
	);
	assert.equal(
		enriched[0].discovered_product_id,
		undefined,
		"name fallback must NOT link discovered_product_id (false-positive guard)",
	);
	assert.equal(stats.nameFallback, 1, "stats.nameFallback counted");
}

// ── Scenario 8: completely unmatched → fresh_search ───────────────────────
{
	const pool = makePool([
		{ name: "商品A", source_url: "https://item.rakuten.co.jp/shop-a/12345/" },
	]);
	const items: GeminiItem[] = [
		{
			name: "全く違う商品",
			source_url: "https://elsewhere.example.com/no-match",
		},
	];
	const { enriched, stats } = attributeSource(items, pool);
	assert.equal(enriched[0].pool_source, "fresh_search", "no match → fresh_search");
	assert.equal(enriched[0].discovered_product_id, undefined, "no ID for unmatched");
	assert.equal(stats.unmatched, 1, "stats.unmatched counted");
}

// ── Scenario 9: composite stats across 4 items ────────────────────────────
{
	const pool = makePool([
		{ source_url: "https://item.rakuten.co.jp/a/1/", discovered_product_id: "p1" },
		{ source_url: "https://item.rakuten.co.jp/b/2/?rafcid=z", discovered_product_id: "p2" },
		{ name: "Unique商品", source_url: "https://shop.example/c/3", discovered_product_id: "p3" },
	]);
	const items: GeminiItem[] = [
		{ name: "x", source_url: "https://item.rakuten.co.jp/a/1/" }, // exact
		{ name: "y", source_url: "https://item.rakuten.co.jp/b/2/" }, // query stripped → url-normalize OR itemCode
		{ name: "Unique商品", source_url: "https://other.example/fake" }, // name fallback
		{ name: "no match", source_url: "https://elsewhere/nope" }, // unmatched
	];
	const { enriched, stats } = attributeSource(items, pool);
	assert.equal(enriched.length, 4);
	assert.equal(enriched[0].pool_source, "discovery_pool");
	assert.equal(enriched[1].pool_source, "discovery_pool");
	assert.equal(enriched[2].pool_source, "discovery_pool");
	assert.equal(enriched[2].discovered_product_id, undefined, "name fallback: no ID");
	assert.equal(enriched[3].pool_source, "fresh_search");
	assert.equal(stats.unmatched, 1);
	assert.equal(stats.nameFallback, 1);
	assert.equal(stats.url + stats.itemCode, 2);
}

// ── Scenario 10: case-insensitive URL host ────────────────────────────────
{
	const pool = makePool([
		{
			source_url: "https://Item.Rakuten.co.jp/Shop/9999/",
			discovered_product_id: "pid-case",
		},
	]);
	const items: GeminiItem[] = [
		{ name: "x", source_url: "https://item.rakuten.co.jp/Shop/9999/" },
	];
	const { enriched } = attributeSource(items, pool);
	assert.equal(enriched[0].pool_source, "discovery_pool", "case-insensitive host");
	assert.equal(enriched[0].discovered_product_id, "pid-case");
}

console.log("PASS: source-attribution (10 scenarios)");
