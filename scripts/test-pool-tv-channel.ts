import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/pool";

// __test exposes pure helpers for unit testing.

// Test A: normalizeDescription
{
	const f = __test.normalizeDescription;
	assert.equal(f("  Hello  WORLD  "), "hello world");
	assert.equal(f("ＡＢＣ ＤＥＦ"), "abc def"); // NFKC
	assert.equal(f("  クッキング\tクックル  "), "クッキング クックル");
}

// Test B: matchAnySeed (substring match against normalized form)
{
	const f = __test.matchAnySeed;
	assert.equal(f("blender mixer 300w", ["mixer"]), true);
	assert.equal(f("blender mixer 300w", ["air fryer"]), false);
	assert.equal(f("ＢＬＥＮＤＥＲ", ["blender"]), false); // normalize done by caller
}

// Test C: groupBroadcastRows — same normalized name across channels → one item with both slugs
{
	const f = __test.groupBroadcastRows;
	const rows = [
		{ channel: "shopch" as const, description: "美顔器 EH-XS10", thumbnail_url: "t1", source_url: "u1", air_date: "2026-05-10" },
		{ channel: "qvc" as const,    description: "美顔器 EH-XS10", thumbnail_url: "t2", source_url: "u2", air_date: "2026-05-11" },
		{ channel: "shopch" as const, description: "別商品", thumbnail_url: "t3", source_url: "u3", air_date: "2026-05-09" },
	];
	const out = f(rows);
	assert.equal(out.length, 2);
	const merged = out.find((p) => p.name.startsWith("美顔器"));
	assert.ok(merged);
	assert.deepEqual(merged!.tvChannelMatches?.slice().sort(), ["qvc", "shopch"]);
	// Most recent slot's thumbnail/url wins (2026-05-11 > 2026-05-10)
	assert.equal(merged!.thumbnailUrl, "t2");
	assert.equal(merged!.productUrl, "u2");
	// Display name preserves original (longest seen)
	assert.equal(merged!.name, "美顔器 EH-XS10");
}

console.log("PASS: pool tv_channel helpers");
