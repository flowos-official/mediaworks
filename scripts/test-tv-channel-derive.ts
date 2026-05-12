import assert from "node:assert/strict";
import { deriveTvChannelSource } from "@/lib/discovery/tv-channels";
import type { PoolItem } from "@/lib/discovery/types";

const base: PoolItem = {
	name: "X",
	productUrl: "https://example.com/x",
	source: "tv_channel",
	seedKeyword: "kw",
	track: "tv_proven",
};

// 1. No channel info → null
assert.equal(deriveTvChannelSource(base), null);

// 2. Single channel via tvChannel
assert.equal(
	deriveTvChannelSource({ ...base, tvChannel: "shopch" }),
	"shopch",
);

// 3. tvChannelMatches takes precedence; output is alphabetically sorted
assert.equal(
	deriveTvChannelSource({
		...base,
		tvChannel: "shopch",
		tvChannelMatches: ["shopch", "qvc"],
	}),
	"qvc,shopch",
);

// 4. tvChannelMatches with duplicates is deduped
assert.equal(
	deriveTvChannelSource({
		...base,
		tvChannelMatches: ["qvc", "qvc", "shopch"],
	}),
	"qvc,shopch",
);

// 5. Empty tvChannelMatches falls back to null (NOT empty string)
assert.equal(
	deriveTvChannelSource({ ...base, tvChannelMatches: [] }),
	null,
);

console.log("PASS: deriveTvChannelSource");
