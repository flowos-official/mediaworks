import assert from "node:assert/strict";
import { aggregatePattern, type AnalysisRow } from "../lib/broadcast-intel/category-pattern";

function row(durationSec: number, channel: "qvc" | "shopch" = "qvc"): AnalysisRow {
	return {
		duration_sec: durationSec,
		channel,
		segments: [
			{ startSec: 0, endSec: durationSec * 0.1, actType: "opening" },
			{ startSec: durationSec * 0.1, endSec: durationSec * 0.5, actType: "demo" },
			{ startSec: durationSec * 0.5, endSec: durationSec, actType: "offer" },
		],
		selling_points: [
			{ order: 1, pointType: "efficacy", firstMentionedSec: durationSec * 0.2, repeatCount: 3 },
			{ order: 2, pointType: "price_value", firstMentionedSec: durationSec * 0.6, repeatCount: 2 },
		],
		evidence_cues: [{ type: "demo", atSec: durationSec * 0.3 }],
		objection_handlings: [{ objectionType: "price", atSec: durationSec * 0.55 }],
		offer_timeline: { firstPriceSec: durationSec * 0.6, ctaSecs: [durationSec * 0.7, durationSec * 0.9] },
	};
}

// Fail-closed: a "measured pattern" from two broadcasts is worse than none.
assert.equal(aggregatePattern([row(1500), row(1500)], "家電"), null);
assert.equal(aggregatePattern([], "家電"), null);

const mixed = [row(720), row(3000), row(1500), row(1800), row(2400)];
const p = aggregatePattern(mixed, "家電")!;
assert.equal(p.sampleSize, 5);
assert.equal(p.category, "家電");
assert.deepEqual(p.channels, ["qvc"]);
assert.equal(p.runtimeMedianSec, 1800);

// Runtimes span 12 to 50 minutes; shares must be runtime-relative or the
// average is meaningless.
const opening = p.actSequence.find((a) => a.actType === "opening")!;
assert.ok(Math.abs(opening.medianShare - 0.1) < 1e-6);
assert.equal(opening.presenceRate, 1);
assert.deepEqual(p.actSequence.map((a) => a.actType), ["opening", "demo", "offer"]);

assert.deepEqual(p.sellingPointOrder.map((s) => s.pointType), ["efficacy", "price_value"]);
assert.equal(p.sellingPointOrder[0].presenceRate, 1);
assert.equal(p.evidenceMix[0].type, "demo");
assert.equal(p.evidenceMix[0].presenceRate, 1);
assert.equal(p.objectionMix[0].type, "price");
assert.ok(Math.abs(p.offerTiming.firstPriceShare! - 0.6) < 1e-6);
assert.equal(p.offerTiming.firstPriceMedianSec, 1080);
assert.equal(p.offerTiming.ctaCountMedian, 2);

// S5: firstPriceMedianSec must be the REAL median of the observed absolute
// seconds, not median-share x median-runtime — that derived figure can land
// on a value no slot in the sample ever produced, while format-prompt.ts
// labels it 「中央値」 (median) to the model.
const nonUniform: AnalysisRow[] = [
	{ ...row(720), offer_timeline: { firstPriceSec: 400, ctaSecs: [] } },
	{ ...row(3000), offer_timeline: { firstPriceSec: 300, ctaSecs: [] } },
	{ ...row(1500), offer_timeline: { firstPriceSec: 900, ctaSecs: [] } },
	{ ...row(1800), offer_timeline: { firstPriceSec: 1080, ctaSecs: [] } },
	{ ...row(2400), offer_timeline: { firstPriceSec: 1440, ctaSecs: [] } },
];
const np = aggregatePattern(nonUniform, "家電")!;
assert.equal(np.runtimeMedianSec, 1800);
assert.ok(Math.abs(np.offerTiming.firstPriceShare! - 0.6) < 1e-6);
assert.equal(
	np.offerTiming.firstPriceMedianSec,
	900,
	"must be the real median of the observed seconds (900) — the old share x runtime formula would wrongly give 1080",
);

// A slot that never announced a price is excluded, not counted as second 0.
const noOffer: AnalysisRow = { ...row(1500), offer_timeline: { firstPriceSec: null, ctaSecs: [] } };
const withGap = aggregatePattern([...mixed, noOffer], "家電")!;
assert.ok(Math.abs(withGap.offerTiming.firstPriceShare! - 0.6) < 1e-6);

// A rare act must be reported as rare, not ranked as if it were universal.
const rare: AnalysisRow = {
	...row(1800),
	segments: [...row(1800).segments, { startSec: 900, endSec: 960, actType: "testimonial" }],
};
const withRare = aggregatePattern([...mixed, rare], "家電")!;
const t = withRare.actSequence.find((a) => a.actType === "testimonial")!;
assert.ok(Math.abs(t.presenceRate - 1 / 6) < 1e-6, "presenceRate must expose how rare an act is");

// Both channels reported, sorted.
const both = aggregatePattern(mixed.map((r, i) => (i % 2 ? { ...r, channel: "shopch" as const } : r)), "家電")!;
assert.deepEqual(both.channels, ["qvc", "shopch"]);

// Nothing free-text may exist anywhere in the aggregate.
assert.deepEqual(Object.keys(p).sort(), [
	"actSequence", "category", "channels", "evidenceMix",
	"objectionMix", "offerTiming", "runtimeMedianSec", "sampleSize", "sellingPointOrder",
]);

console.log("PASS: broadcast-intel aggregate");
