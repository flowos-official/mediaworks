/**
 * Verification test for the new source/tv_channel_source propagation
 * behavior in lib/strategy/source-attribution.ts.
 *
 * Before this change attributeSource only restored pool_source +
 * discovered_product_id. The new behavior must also overlay the matched
 * pool row's `source` and `tv_channel_source` onto the Gemini item so
 * tv_channel candidates surface as "TV局" in the UI instead of the
 * generic 楽天/Web badge.
 */

import assert from "node:assert/strict";
import {
	attributeSource,
	type AttributablePoolItem,
} from "@/lib/strategy/source-attribution";

type GeminiItem = {
	name: string;
	source_url: string;
	source: "rakuten" | "web" | "brave" | "tv_channel" | "other";
	tv_channel_source?: string | null;
	otherField?: string;
};

// 1. URL match propagates tv_channel + slug from pool over Gemini's guess
{
	const pool: AttributablePoolItem[] = [
		{
			name: "ジャパネット限定モデル",
			source_url: "https://www.japanet.co.jp/item/AB-123",
			pool_source: "discovery_pool",
			discovered_product_id: "pool-id-1",
			source: "tv_channel",
			tv_channel_source: "japanet",
		},
	];
	const gemini: GeminiItem[] = [
		{
			name: "ジャパネット限定モデル",
			source_url: "https://www.japanet.co.jp/item/AB-123",
			source: "rakuten", // <-- Gemini guessed wrong
			tv_channel_source: null,
			otherField: "untouched",
		},
	];
	const { enriched, stats } = attributeSource(gemini, pool);
	assert.equal(stats.url, 1);
	assert.equal(enriched.length, 1);
	assert.equal(
		enriched[0].source,
		"tv_channel",
		"source should be overwritten from pool",
	);
	assert.equal(
		enriched[0].tv_channel_source,
		"japanet",
		"tv_channel_source should be propagated from pool",
	);
	assert.equal(enriched[0].pool_source, "discovery_pool");
	assert.equal(enriched[0].discovered_product_id, "pool-id-1");
	assert.equal(
		(enriched[0] as GeminiItem & { otherField?: string }).otherField,
		"untouched",
		"unrelated fields on the Gemini item must survive",
	);
}

// 2. Rakuten itemCode match also propagates source
{
	const pool: AttributablePoolItem[] = [
		{
			name: "テスト商品",
			source_url: "https://item.rakuten.co.jp/shopA/itemX/",
			pool_source: "fresh_search",
			source: "rakuten",
			tv_channel_source: null,
		},
	];
	const gemini: GeminiItem[] = [
		{
			name: "テスト商品",
			// URL rewritten (different query string) but same itemCode
			source_url: "https://item.rakuten.co.jp/shopA/itemX/?tracking=foo",
			source: "web", // wrong guess
			tv_channel_source: null,
		},
	];
	const { enriched, stats } = attributeSource(gemini, pool);
	// Either url-normalize or itemCode rescue should match; we accept either path.
	assert.ok(stats.url + stats.itemCode === 1);
	assert.equal(enriched[0].source, "rakuten");
	assert.equal(enriched[0].tv_channel_source, null);
}

// 3. Unmatched item keeps Gemini-provided source (no overwrite to undefined)
{
	const pool: AttributablePoolItem[] = [
		{
			name: "プール内商品",
			source_url: "https://example.com/pool",
			pool_source: "discovery_pool",
			source: "rakuten",
		},
	];
	const gemini: GeminiItem[] = [
		{
			name: "幻覚商品",
			source_url: "https://hallucinated.example/none",
			source: "web",
		},
	];
	const { enriched, stats } = attributeSource(gemini, pool);
	assert.equal(stats.unmatched, 1);
	assert.equal(enriched[0].pool_source, "fresh_search");
	assert.equal(
		enriched[0].source,
		"web",
		"Gemini's source must be preserved when no pool match",
	);
}

// 4. Pool match with NO source field — Gemini's source survives (no nuking)
{
	const pool: AttributablePoolItem[] = [
		{
			name: "サンプル",
			source_url: "https://example.com/sample",
			pool_source: "discovery_pool",
			// source intentionally omitted (legacy pool item)
		},
	];
	const gemini: GeminiItem[] = [
		{
			name: "サンプル",
			source_url: "https://example.com/sample",
			source: "rakuten",
		},
	];
	const { enriched, stats } = attributeSource(gemini, pool);
	assert.equal(stats.url, 1);
	assert.equal(
		enriched[0].source,
		"rakuten",
		"Should keep Gemini's source when pool has none",
	);
	assert.equal(enriched[0].tv_channel_source, null);
}

console.log("PASS: source-attribution propagation (4 scenarios)");
