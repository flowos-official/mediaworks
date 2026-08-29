import assert from "node:assert/strict";

import {
	buildBackfillCursor,
	executeBackfillPage,
	mapBroadcastAnalysisEvidence,
	mapDiscoveredProductEvidence,
	parseBackfillArgs,
	parseBackfillCursor,
	type BroadcastAnalysisBackfillRow,
	type DiscoveredProductBackfillRow,
} from "../lib/intelligence/backfill";

const PRODUCT_OBSERVED_AT = "2026-08-29T01:02:03.000Z";

const productRow: DiscoveredProductBackfillRow = {
	id: "discovered-product-1",
	canonicalProductId: "canonical-product-1",
	name: "スチームアイロン",
	category: "家電",
	normalizedCategory: "家電",
	productUrl: "https://www.qvc.jp/product/1",
	priceJpy: 12_800,
	reviewCount: null,
	tvEvidence: { airing_count: 4 },
	observedAt: PRODUCT_OBSERVED_AT,
};

const productEvidence = mapDiscoveredProductEvidence(productRow);
const productByPredicate = new Map(productEvidence.map((draft) => [draft.predicate, draft]));

assert.equal(productEvidence.length, 5);
assert.equal(productByPredicate.get("name")?.evidenceClass, "source_claim");
assert.equal(productByPredicate.get("normalized_category")?.evidenceClass, "inferred");
assert.equal(productByPredicate.get("price_jpy")?.evidenceClass, "verified");
assert.equal(productByPredicate.get("price_jpy")?.valueState, "known");
assert.equal(productByPredicate.get("price_jpy")?.value, 12_800);
assert.equal(productByPredicate.get("review_count")?.evidenceClass, "proxy");
assert.equal(productByPredicate.get("review_count")?.valueState, "unknown");
assert.equal(productByPredicate.get("review_count")?.value, undefined);
assert.equal(productByPredicate.get("tv_airing_count")?.evidenceClass, "proxy");
assert.equal(productByPredicate.get("tv_airing_count")?.valueState, "known");
assert.equal(productByPredicate.get("tv_airing_count")?.value, 4);
for (const draft of productEvidence) {
	assert.equal(draft.sourceUrl, productRow.productUrl);
	assert.equal(draft.observedAt, PRODUCT_OBSERVED_AT);
}

const unknownProductEvidence = mapDiscoveredProductEvidence({
	...productRow,
	name: null,
	priceJpy: null,
	tvEvidence: null,
	normalizedCategory: null,
});
for (const predicate of ["name", "normalized_category", "price_jpy", "review_count", "tv_airing_count"]) {
	const draft = unknownProductEvidence.find((item) => item.predicate === predicate);
	assert.equal(draft?.valueState, "unknown", `${predicate} remains unknown when absent`);
	assert.equal(draft?.value, undefined, `${predicate} never turns absence into numeric zero`);
}

const broadcastRow: BroadcastAnalysisBackfillRow = {
	broadcastId: "broadcast-1",
	channel: "qvc",
	airDate: "2026-08-28",
	durationSec: 1_800,
	segments: [{ act_type: "opening", start_sec: 0, end_sec: 10 }],
	sellingPoints: [{ point_type: "ease_of_use", first_mentioned_sec: 12 }],
	evidenceCues: [{ type: "demo", at_sec: 20 }],
	objectionHandlings: [{ objection_type: "price", at_sec: 30 }],
	offerTimeline: { first_price_sec: 60, cta_secs: [90] },
	observedAt: "2026-08-29T02:03:04.000Z",
	sourceUrl: "https://www.qvc.jp/program/1",
};

const broadcastEvidence = mapBroadcastAnalysisEvidence(broadcastRow);
const broadcastByPredicate = new Map(broadcastEvidence.map((draft) => [draft.predicate, draft]));
assert.equal(broadcastEvidence.length, 7);
assert.equal(broadcastByPredicate.get("air_date")?.evidenceClass, "verified");
assert.equal(broadcastByPredicate.get("duration_sec")?.evidenceClass, "verified");
for (const predicate of ["segment_pattern", "selling_points", "evidence_cues", "objection_handlings", "offer_timing"]) {
	const draft = broadcastByPredicate.get(predicate);
	assert.equal(draft?.evidenceClass, "inferred", `${predicate} is model-derived`);
	assert.equal(draft?.valueState, "known", `${predicate} keeps a known JSON value`);
	assert.equal(draft?.sourceUrl, broadcastRow.sourceUrl);
	assert.equal(draft?.observedAt, broadcastRow.observedAt);
}
assert.deepEqual(broadcastByPredicate.get("segment_pattern")?.value, broadcastRow.segments);
assert.deepEqual(broadcastByPredicate.get("selling_points")?.value, broadcastRow.sellingPoints);
assert.ok(Array.isArray(broadcastByPredicate.get("evidence_cues")?.value));

const unknownBroadcastEvidence = mapBroadcastAnalysisEvidence({
	...broadcastRow,
	airDate: null,
	durationSec: null,
	segments: null,
	sellingPoints: null,
	evidenceCues: null,
	objectionHandlings: null,
	offerTimeline: null,
});
for (const predicate of ["air_date", "duration_sec", "segment_pattern", "selling_points", "evidence_cues", "objection_handlings", "offer_timing"]) {
	const draft = unknownBroadcastEvidence.find((item) => item.predicate === predicate);
	assert.equal(draft?.valueState, "unknown", `${predicate} is honestly unknown when absent`);
	assert.equal(draft?.value, undefined, `${predicate} is never substituted with zero or an empty JSON value`);
}

const argsCursor = buildBackfillCursor({
	products: { observedAt: "2026-08-01T00:00:00.000Z", id: "discovered-product-0" },
});
const parsed = parseBackfillArgs([
	"--since=2026-08-01",
	"--limit=20",
	`--cursor=${argsCursor}`,
	"--apply",
]);
assert.deepEqual(parsed, {
	since: "2026-08-01T00:00:00.000Z",
	limit: 20,
	cursor: argsCursor,
	apply: true,
});
assert.equal(parseBackfillArgs([]).limit, 200);
assert.equal(parseBackfillArgs(["--limit=2000"]).limit, 2000);
assert.throws(() => parseBackfillArgs(["--limit=2001"]), /must not exceed 2000/);
assert.throws(() => parseBackfillArgs(["--limit=0"]), /positive integer/);
assert.throws(() => parseBackfillArgs(["--since=nope"]), /ISO date or timestamp/);

const cursor = buildBackfillCursor({
	products: { observedAt: PRODUCT_OBSERVED_AT, id: "discovered-product-1" },
	broadcasts: { observedAt: "2026-08-29T02:03:04.000Z", id: "broadcast-1" },
});
assert.deepEqual(parseBackfillCursor(cursor), {
	products: { observedAt: PRODUCT_OBSERVED_AT, id: "discovered-product-1" },
	broadcasts: { observedAt: "2026-08-29T02:03:04.000Z", id: "broadcast-1" },
});
assert.equal(buildBackfillCursor(parseBackfillCursor(cursor)), cursor, "cursor serialization is deterministic");
assert.throws(() => parseBackfillCursor("not-a-cursor"), /invalid cursor/);

async function verifyDryRun(): Promise<void> {
	let writes = 0;
	let normalizedInputs: string[] = [];
	const dryRun = await executeBackfillPage({
		products: [productRow],
		broadcasts: [broadcastRow],
		normalizeCategories: async (rawCategories) => {
			normalizedInputs = rawCategories;
			return new Map(rawCategories.map((category) => [category, ["家電"]]));
		},
		write: false,
		applyProduct: async () => { writes += 1; },
		applyBroadcast: async () => { writes += 1; },
	});
	assert.equal(writes, 0, "dry run never invokes write callbacks");
	assert.equal(dryRun.productEvidenceCount, 5);
	assert.equal(dryRun.broadcastEvidenceCount, 7);
	assert.equal(dryRun.reviewNeeded.missingNormalizedCategory, 0);
	assert.deepEqual(normalizedInputs, ["家電"], "normalizer receives distinct raw page categories");

	const reviewOnly = await executeBackfillPage({
		products: [productRow],
		broadcasts: [],
		normalizeCategories: async () => new Map(),
		write: false,
	});
	assert.equal(reviewOnly.reviewNeeded.missingNormalizedCategory, 1);
	assert.deepEqual(reviewOnly.reviewNeededCategories, ["家電"], "unclassified raw categories are reported for review");

	console.log("PASS: intelligence foundation backfill");
}

verifyDryRun().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
