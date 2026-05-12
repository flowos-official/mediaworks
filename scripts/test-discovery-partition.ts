import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/orchestrator";
import type { Candidate } from "@/lib/discovery/types";

function mkCandidate(score: number, tvSrc: string | null): Candidate {
	return {
		name: `c${score}`,
		productUrl: `https://x/${score}`,
		source: tvSrc ? "tv_channel" : "rakuten",
		seedKeyword: "k",
		track: "tv_proven",
		context: "home_shopping",
		tvFitScore: score,
		tvFitReason: "r",
		isTvApplicable: true,
		isLiveApplicable: false,
		scoreBreakdown: {
			review_signal: 0,
			tv_category_match: 0,
			trend_signal: 0,
			price_fit: 0,
			purchase_signal: 0,
			total: score,
		},
		tvChannelSource: tvSrc,
	};
}

// Mixed input: tier-1 (with tvChannelSource) must come first regardless of score.
const input: Candidate[] = [
	mkCandidate(95, null),    // tier-2, highest score
	mkCandidate(40, "shopch"),// tier-1, low score
	mkCandidate(70, null),    // tier-2
	mkCandidate(60, "qvc"),   // tier-1
];

const out = __test.partitionByTier(input);

// Order: all tier-1 first (score-DESC), then all tier-2 (score-DESC).
assert.deepEqual(
	out.map((c) => c.name),
	["c60", "c40", "c95", "c70"],
);

console.log("PASS: partitionByTier orders TV channel candidates first, score-DESC within tier");
