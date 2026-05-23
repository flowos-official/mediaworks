import {
	__test,
	aggregateBroadcastRows,
	applyEvidenceBonus,
	type BroadcastRow,
} from "../lib/discovery/tv-evidence";
import type { TvEvidence } from "../lib/discovery/types";

const { splitCategoryToKeywords, tokenizeName, percentile } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

// splitCategoryToKeywords
assert(
	JSON.stringify(splitCategoryToKeywords("美容・運動")) === JSON.stringify(["美容", "運動"]),
	'splitCategoryToKeywords("美容・運動") → ["美容","運動"]',
);
assert(
	JSON.stringify(splitCategoryToKeywords("化粧品")) === JSON.stringify(["化粧品"]),
	"single-token category passes through",
);
// "a", "b", "c" are all 1-char tokens and fail the ≥2 filter → []
// Plan had expected ["a","b","c"] but that contradicts length>=2; corrected to [].
// The assertion still verifies that BOTH delimiters (/ and ・) split correctly —
// we just confirm the split happens and short tokens are dropped.
assert(
	JSON.stringify(splitCategoryToKeywords("a/b・c")) === JSON.stringify([]),
	"slash + middle-dot both split (1-char tokens a/b/c all dropped by ≥2 filter → [])",
);
assert(
	splitCategoryToKeywords("").length === 0,
	"empty input → empty array",
);
// "お" (1 codepoint) and "x" (1 char) both fail the ≥2 filter → []
// Plan had expected ["お"] but that contradicts the length>=2 filter; corrected to [].
assert(
	JSON.stringify(splitCategoryToKeywords("お・x")) === JSON.stringify([]),
	"tokens <2 chars filtered — both 'お' (1 codepoint) and 'x' (1 char) dropped → []",
);

// tokenizeName
assert(
	JSON.stringify(tokenizeName("無印良品 美容液 30ml")) === JSON.stringify(["無印良品", "美容液", "30ml"]),
	"tokenizeName splits on whitespace and drops short tokens",
);
assert(
	tokenizeName("a b c").length === 0,
	"all-short tokens → empty",
);
assert(
	tokenizeName("セラム").length === 1 && tokenizeName("セラム")[0] === "セラム",
	"single Japanese token kept",
);

// percentile
assert(percentile([1, 2, 3, 4, 5], 0.5) === 3, "median of [1..5] = 3");
assert(percentile([1, 2, 3, 4], 0.5) === 2.5, "median of [1..4] = 2.5");
assert(percentile([10], 0.5) === 10, "single-element percentile = element");
assert(percentile([], 0.5) === 0, "empty array percentile = 0");

// aggregateBroadcastRows
const daysAgoIso = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const rows: BroadcastRow[] = [
	{ source: "broadcasts", channel: "qvc", air_date: daysAgoIso(5), start_time: "14:00:00", title: "セラムA", price_jpy: 5000 },
	{ source: "broadcasts", channel: "qvc", air_date: daysAgoIso(10), start_time: "14:00:00", title: "セラムB", price_jpy: 6000 },
	{ source: "broadcasts", channel: "shopch", air_date: daysAgoIso(40), start_time: "20:00:00", title: "セラムC", price_jpy: 8000 },
	{ source: "historical", channel: "japanet", air_date: daysAgoIso(100), start_time: null, title: "セラムD", price_jpy: 7000 },
	{ source: "historical", channel: "japanet", air_date: daysAgoIso(200), start_time: null, title: "セラムE", price_jpy: 7500 },
];

const ev = aggregateBroadcastRows(rows, {
	category_keywords: ["美容"],
	price_band: [3000, 9000],
	name_tokens: ["セラム"],
});

assert(ev.airing_count === 5, "airing_count = 5");
assert(ev.recent_30d_count === 2, "recent_30d_count = 2 (5d, 10d)");
assert(ev.recent_90d_count === 3, "recent_90d_count = 3 (5d, 10d, 40d)");
assert(ev.channel_breakdown.qvc === 2, "qvc breakdown = 2");
assert(ev.channel_breakdown.shopch === 1, "shopch breakdown = 1");
assert(ev.channel_breakdown.japanet === 2, "japanet breakdown = 2");
assert(ev.price_jpy !== null && ev.price_jpy.count === 5, "all 5 prices included");
assert(ev.price_jpy?.median === 7000, "median price = 7000");
assert(ev.top_timeslots.length > 0, "at least one timeslot bucket");
assert(
	ev.top_timeslots[0].channel === "qvc" && ev.top_timeslots[0].hour_bucket === 14,
	"top timeslot is qvc 14:00",
);
assert(ev.samples.length <= 5, "samples capped at 5");
assert(ev.samples[0].air_date === daysAgoIso(5), "samples sorted by recency");

// Empty input
const emptyEv = aggregateBroadcastRows([], {
	category_keywords: [],
	price_band: null,
	name_tokens: [],
});
assert(emptyEv.airing_count === 0, "empty input → airing_count 0");
assert(emptyEv.price_jpy === null, "empty input → price_jpy null");

if (process.exitCode === 1) process.exit(1);
console.log("\nAll unit tests passed.");

// ────────────────────────────────────────────────────────────────────────────
// applyEvidenceBonus tests
// ────────────────────────────────────────────────────────────────────────────

const baseCandidate = (score: number) => ({
	name: "test",
	productUrl: "https://example.com/x",
	source: "rakuten" as const,
	seedKeyword: "kw",
	track: "tv_proven" as const,
	context: "home_shopping" as const,
	tvFitScore: score,
	tvFitReason: "test",
	isTvApplicable: true,
	isLiveApplicable: false,
	scoreBreakdown: { review_signal: 0, tv_category_match: 0, trend_signal: 0, price_fit: 0, purchase_signal: 0, total: 0 },
});

const tvEvidence = (evidenceStrength: number): TvEvidence => ({
	matched_at: "2026-05-23T00:00:00.000Z",
	match_basis: {
		category_keywords: [],
		price_band: null,
		name_tokens: [],
	},
	airing_count: 1,
	recent_30d_count: 1,
	recent_90d_count: 1,
	channel_breakdown: { qvc: 1 },
	price_jpy: null,
	top_timeslots: [],
	samples: [],
	evidence_strength: evidenceStrength,
});

const c1 = baseCandidate(50);
c1.productUrl = "https://example.com/x";
const c2 = baseCandidate(60);
c2.productUrl = "https://example.com/y";

const evMap = new Map([
	[c1.productUrl, tvEvidence(0.8)],
	[c2.productUrl, null],
]);

const bonusCount = applyEvidenceBonus([c1, c2], evMap);

assert(bonusCount === 1, "exactly one candidate received a bonus");
assert(c1.tvFitScore === 50 + Math.round(0.8 * 15), "c1 bonus = round(0.8*15) = 12");
assert(c2.tvFitScore === 60, "c2 unchanged (null evidence)");
assert(c1.tvFitReason.includes("実測"), "c1 reason annotated");

// Cap at 100
const c3 = baseCandidate(95);
c3.productUrl = "https://example.com/z";
const evMap2 = new Map([[c3.productUrl, tvEvidence(1.0)]]);
applyEvidenceBonus([c3], evMap2);
assert(c3.tvFitScore === 100, "score capped at 100");

if (process.exitCode === 1) process.exit(1);
console.log("\nAll applyEvidenceBonus tests passed.");
