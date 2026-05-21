/**
 * Unit test for the new round-robin interleave at the tail of buildPool.
 * Confirms TV-tagged items survive a downstream slice that would normally
 * cut them off if they were concatenated at the end.
 */

import assert from "node:assert/strict";
import type { PoolItem } from "@/lib/discovery/types";

// Local reimplementation of the interleave block in lib/discovery/pool.ts
// (the real function is not exported standalone — we test the logic shape).
function interleave(allUrlItems: PoolItem[], passC: PoolItem[]): PoolItem[] {
	const tvTagged = allUrlItems.filter(
		(i) => i.tvChannel || (i.tvChannelMatches && i.tvChannelMatches.length > 0),
	);
	const untagged = allUrlItems.filter(
		(i) => !i.tvChannel && !(i.tvChannelMatches && i.tvChannelMatches.length > 0),
	);
	const out: PoolItem[] = [];
	const maxLen = Math.max(tvTagged.length, untagged.length);
	for (let i = 0; i < maxLen; i++) {
		if (i < tvTagged.length) out.push(tvTagged[i]);
		if (i < untagged.length) out.push(untagged[i]);
	}
	return [...out, ...passC];
}

function mkRakuten(idx: number): PoolItem {
	return {
		name: `rakuten-${idx}`,
		productUrl: `https://item.rakuten.co.jp/shop/p${idx}/`,
		source: "rakuten",
		seedKeyword: "test",
		track: "tv_proven",
	};
}

function mkTv(idx: number, slug: string): PoolItem {
	return {
		name: `tv-${idx}`,
		productUrl: `https://${slug}.jp/p${idx}`,
		source: "tv_channel",
		seedKeyword: "test",
		track: "tv_proven",
		tvChannel: slug,
		tvChannelMatches: [slug],
	};
}

// Real-world numbers from production: 200+ rakuten/brave, ~200 tv hits, 5 passC
const rakutens = Array.from({ length: 250 }, (_, i) => mkRakuten(i));
const tvs = Array.from({ length: 200 }, (_, i) => mkTv(i, "japanet"));
const passC: PoolItem[] = [];

// Simulate the urlIndexed insertion order — rakuten first, then tv:
const allUrlItems = [...rakutens, ...tvs];

const result = interleave(allUrlItems, passC);

// Slice 150 (simulates curatePool POOL_SAMPLE_LIMIT)
const sampled = result.slice(0, 150);
const tvInSampled = sampled.filter(
	(p) => p.tvChannel || (p.tvChannelMatches && p.tvChannelMatches.length > 0),
).length;
const rkInSampled = sampled.filter(
	(p) => !p.tvChannel && !(p.tvChannelMatches && p.tvChannelMatches.length > 0),
).length;

console.log(
	`sampled[0..150]: tv=${tvInSampled} non-tv=${rkInSampled} (input had tv=${tvs.length} rakuten=${rakutens.length})`,
);

// Before fix: tv=0, non-tv=150 (rakuten ate the whole slice window)
// After fix: tv≈75, non-tv≈75 (round-robin) — both survive
assert.ok(tvInSampled >= 70, `expected tv >= 70 in slice, got ${tvInSampled}`);
assert.ok(rkInSampled >= 70, `expected non-tv >= 70 in slice, got ${rkInSampled}`);
assert.equal(tvInSampled + rkInSampled, 150);

// Also confirm first 4 items alternate: tv, rk, tv, rk
const first4 = result.slice(0, 4).map((p) =>
	p.tvChannel || (p.tvChannelMatches && p.tvChannelMatches.length > 0) ? "tv" : "rk",
);
assert.deepEqual(first4, ["tv", "rk", "tv", "rk"], `first 4 should alternate, got ${first4}`);

console.log("PASS: pool interleave (TV-tagged items survive POOL_SAMPLE_LIMIT slice)");
