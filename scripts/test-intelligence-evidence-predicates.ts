/**
 * evidence_items is member|admin because it is derived from member|admin
 * sources (20260830100000_intelligence_access_grades.sql). That grade holds
 * only as long as the derivation stays inside the shape it was reviewed at.
 *
 * The broadcast side is the one that has to stay honest: AnalysisPatterns is
 * documented as "every value here is a number or an enum label", and
 * parseAnalysisResponse routes the verbatim half — transcript, summaryJa — to
 * admin-only broadcast_transcripts instead. Nothing enforces that split at the
 * backfill boundary, so a later edit could quietly widen what crosses into
 * evidence without anyone re-reading the policy.
 *
 * This pins the predicate set. Adding one is fine; it just has to be a
 * deliberate edit here, with the grade re-checked at the same time.
 */
import assert from "node:assert/strict";

import {
	mapBroadcastAnalysisEvidence,
	mapDiscoveredProductEvidence,
} from "../lib/intelligence/backfill";

const PRODUCT_PREDICATES = [
	"name",
	"normalized_category",
	"price_jpy",
	"review_count",
	"tv_airing_count",
] as const;

const BROADCAST_PREDICATES = [
	"air_date",
	"duration_sec",
	"segment_pattern",
	"selling_points",
	"evidence_cues",
	"objection_handlings",
	"offer_timing",
] as const;

/** Verbatim competitor text lives in admin-only tables and never in evidence. */
const FORBIDDEN_PREDICATE_FRAGMENTS = ["transcript", "summary", "verbatim", "text_ja", "urgency"];

function main(): void {
	const productPredicates = mapDiscoveredProductEvidence({
		id: "11111111-1111-4111-8111-111111111111",
		name: "テスト商品",
		normalizedCategory: "家電",
		priceJpy: 12800,
		reviewCount: 42,
		productUrl: "https://example.test/p/1",
		tvEvidence: { airing_count: 3, matched_at: "2026-08-29T00:00:00.000Z" },
		observedAt: "2026-08-29T00:00:00+00:00",
	} as never).map((draft) => draft.predicate);

	assert.deepEqual(
		[...productPredicates].sort(),
		[...PRODUCT_PREDICATES].sort(),
		"Discovery evidence predicates changed. Re-check the evidence_items grade before widening this set.",
	);

	const broadcastPredicates = mapBroadcastAnalysisEvidence({
		broadcastId: "22222222-2222-4222-8222-222222222222",
		channel: "qvc",
		airDate: "2026-08-28",
		durationSec: 120,
		segments: [],
		sellingPoints: [],
		evidenceCues: [],
		objectionHandlings: [],
		offerTimeline: { firstPriceSec: null, ctaSecs: [] },
		observedAt: "2026-08-29T00:00:00+00:00",
	} as never).map((draft) => draft.predicate);

	assert.deepEqual(
		[...broadcastPredicates].sort(),
		[...BROADCAST_PREDICATES].sort(),
		"Broadcast evidence predicates changed. Re-check the evidence_items grade before widening this set.",
	);

	for (const predicate of [...productPredicates, ...broadcastPredicates]) {
		for (const fragment of FORBIDDEN_PREDICATE_FRAGMENTS) {
			assert.ok(
				!predicate.toLowerCase().includes(fragment),
				`Evidence predicate "${predicate}" looks like verbatim content. That half belongs in admin-only broadcast_transcripts.`,
			);
		}
	}

	console.log("PASS: intelligence evidence predicate whitelist");
}

main();
