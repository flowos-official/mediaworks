import assert from "node:assert/strict";
import {
	ACT_TYPES,
	EVIDENCE_TYPES,
	OBJECTION_TYPES,
	POINT_TYPES,
	parseAnalysisResponse,
} from "../lib/broadcast-intel/schema";

const good = {
	transcript: [{ start_sec: 0, end_sec: 12, speaker_hint: "host", text_ja: "こんにちは" }],
	segments: [{ start_sec: 0, end_sec: 120, act_type: "opening", summary_ja: "導入" }],
	selling_points: [{ order: 1, point_type: "efficacy", first_mentioned_sec: 130, repeat_count: 4 }],
	evidence_cues: [{ type: "demo", at_sec: 300 }],
	objection_handlings: [{ objection_type: "price", at_sec: 900 }],
	offer_timeline: { first_price_sec: 940, cta_secs: [960, 1200], urgency_cues: ["残りわずか"] },
};

const parsed = parseAnalysisResponse(good, 1500);

// The two halves must stay apart: patterns are member-readable, verbatim is not.
assert.equal(parsed.patterns.segments[0].actType, "opening");
assert.equal(parsed.patterns.sellingPoints[0].pointType, "efficacy");
assert.equal(parsed.patterns.offerTimeline.firstPriceSec, 940);
assert.equal(parsed.verbatim.transcript[0].textJa, "こんにちは");
assert.equal(parsed.verbatim.actSummaries[0].summaryJa, "導入");
assert.deepEqual(parsed.verbatim.urgencyCues, ["残りわずか"]);

// Nothing free-text may survive into the member-readable half. This is the
// invariant the whole design rests on, so assert it structurally.
const patternsDump = JSON.stringify(parsed.patterns);
for (const needle of ["こんにちは", "導入", "残りわずか"]) {
	assert.ok(!patternsDump.includes(needle), `patterns leaked verbatim text: ${needle}`);
}
assert.deepEqual(Object.keys(parsed.patterns).sort(), [
	"evidenceCues", "objectionHandlings", "offerTimeline", "segments", "sellingPoints",
]);
assert.deepEqual(Object.keys(parsed.patterns.segments[0]).sort(), ["actType", "endSec", "startSec"]);
assert.deepEqual(Object.keys(parsed.patterns.offerTimeline).sort(), ["ctaSecs", "firstPriceSec"]);

// Behavioural enum coverage: every declared label must survive a round trip,
// and an undeclared one must be dropped. (Comparing the schema's enum array to
// the const array it was generated from would prove nothing.)
for (const act of ACT_TYPES) {
	const r = parseAnalysisResponse({ ...good, segments: [{ start_sec: 0, end_sec: 10, act_type: act, summary_ja: "" }] }, 1500);
	assert.equal(r.patterns.segments[0]?.actType, act, `act_type ${act} was dropped`);
}
for (const p of POINT_TYPES) {
	const r = parseAnalysisResponse({ ...good, selling_points: [{ order: 1, point_type: p, first_mentioned_sec: 10, repeat_count: 1 }] }, 1500);
	assert.equal(r.patterns.sellingPoints[0]?.pointType, p, `point_type ${p} was dropped`);
}
for (const e of EVIDENCE_TYPES) {
	const r = parseAnalysisResponse({ ...good, evidence_cues: [{ type: e, at_sec: 10 }] }, 1500);
	assert.equal(r.patterns.evidenceCues[0]?.type, e, `evidence type ${e} was dropped`);
}
for (const o of OBJECTION_TYPES) {
	const r = parseAnalysisResponse({ ...good, objection_handlings: [{ objection_type: o, at_sec: 10 }] }, 1500);
	assert.equal(r.patterns.objectionHandlings[0]?.objectionType, o, `objection ${o} was dropped`);
}

// Unknown label dropped, known one kept.
const junk = parseAnalysisResponse({ ...good, evidence_cues: [{ type: "telepathy", at_sec: 10 }, { type: "demo", at_sec: 20 }] }, 1500);
assert.deepEqual(junk.patterns.evidenceCues, [{ type: "demo", atSec: 20 }]);

// A timecode past the runtime is impossible and must be dropped.
const pastEnd = parseAnalysisResponse({ ...good, evidence_cues: [{ type: "demo", at_sec: 9999 }] }, 1500);
assert.deepEqual(pastEnd.patterns.evidenceCues, []);

// Malformed payload throws — and the message names the field that is wrong.
// NOTE: transcript is validated first, so it must be well-formed here or the
// assertion would match the wrong error.
assert.throws(
	() => parseAnalysisResponse({ transcript: [], segments: "nope" }, 1500),
	/segments must be an array/,
);

console.log("PASS: broadcast-intel schema");
