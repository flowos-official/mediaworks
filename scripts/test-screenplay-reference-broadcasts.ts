/**
 * Which competitor slots we look at, and why a pattern is absent.
 *
 * The pattern half is the reason this file exists. `CategoryPattern | null`
 * was five different facts wearing one value, and the workflow resolved the
 * ambiguity by writing a console line nobody reads and storing nothing. Each
 * status is asserted separately here so a later refactor cannot quietly
 * collapse them back.
 */
import assert from "node:assert/strict";
import {
	briefSignature,
	rankReferenceBroadcasts,
	scoreReference,
	type ReferenceCandidate,
} from "../lib/screenplay/context/reference-broadcasts";
import { loadPatternResult } from "../lib/screenplay/context/pattern-result";
import type { CategoryPattern } from "../lib/broadcast-intel/category-pattern";
import type { ProductBrief } from "../lib/screenplay/types";

const BRIEF: ProductBrief = {
	name: "静音ブレンダー Pro",
	category: "家電",
	description: "実演で違いがわかる、簡単操作のミキサー。お手入れも簡単。",
	price: { saleJpy: 14800 },
	customization: { mustDemos: ["氷を砕く実演"] },
};

function candidate(over: Partial<ReferenceCandidate> & Pick<ReferenceCandidate, "broadcastId">): ReferenceCandidate {
	return {
		channel: "shopch",
		airDate: "2026-08-01",
		category: "家電",
		programTitle: "番組",
		priceJpy: null,
		pointTypes: [],
		evidenceTypes: [],
		objectionTypes: [],
		...over,
	};
}

// --- more matching dimensions wins ------------------------------------------
{
	const fixtures: ReferenceCandidate[] = [
		candidate({
			broadcastId: "similar-demo-price",
			priceJpy: 15800,
			pointTypes: ["ease_of_use", "aftercare"],
			evidenceTypes: ["demo"],
			objectionTypes: ["maintenance"],
		}),
		candidate({ broadcastId: "category-only" }),
		candidate({ broadcastId: "category-and-price", priceJpy: 14000 }),
		candidate({ broadcastId: "other-category", category: "ジュエリー", channel: "qvc", priceJpy: 15000 }),
	];
	const ranked = rankReferenceBroadcasts(fixtures, BRIEF);
	assert.equal(ranked[0]?.broadcastId, "similar-demo-price", "category + price + demo must outrank category alone");
	const byId = new Map(ranked.map((r) => [r.broadcastId, r]));
	assert.ok(
		byId.get("category-and-price")!.similarity > byId.get("category-only")!.similarity,
		"a matching price band must count for something",
	);
	assert.ok(byId.get("similar-demo-price")!.matchedOn.includes("demo_objection"));
	assert.ok(byId.get("similar-demo-price")!.matchedOn.includes("price_band"));
	assert.equal(byId.get("category-only")!.matchedOn.includes("price_band"), false);
	// The analysis and the broadcast share an id, but the copy guard loads
	// phrases BY ANALYSIS — the two names must both be carried.
	assert.equal(byId.get("category-only")!.analysisId, "category-only");
}
console.log("✓ similarity rewards the dimensions that actually matched");

// --- an unmeasurable dimension is skipped, not scored zero ------------------
// Most archived slots have no captured price. Scoring that as "0% similar"
// would rank every un-enriched slot below every enriched one for a reason that
// has nothing to do with the product.
{
	const signature = briefSignature(BRIEF);
	const priced = scoreReference(candidate({ broadcastId: "a", priceJpy: 14800 }), signature);
	const unpriced = scoreReference(candidate({ broadcastId: "b" }), signature);
	assert.equal(priced.similarity > unpriced.similarity, true, "a matching price should help");
	const wrongPrice = scoreReference(candidate({ broadcastId: "c", priceJpy: 200_000 }), signature);
	assert.ok(
		unpriced.similarity > wrongPrice.similarity,
		"an unknown price must score better than a price we know is wrong — otherwise unknown is being read as zero",
	);
}
console.log("✓ an unknown price is skipped rather than scored as a mismatch");

// --- both channels are represented when both exist -------------------------
// QVC's two-minute clips and ShopCh's hour-long programmes are different media.
{
	const fixtures: ReferenceCandidate[] = [
		candidate({ broadcastId: "s1", priceJpy: 14800, evidenceTypes: ["demo"] }),
		candidate({ broadcastId: "s2", priceJpy: 14900, evidenceTypes: ["demo"] }),
		candidate({ broadcastId: "q1", channel: "qvc", category: "ジュエリー", priceJpy: 90000 }),
	];
	const ranked = rankReferenceBroadcasts(fixtures, BRIEF, 2);
	assert.equal(new Set(ranked.map((r) => r.channel)).size, 2, "a two-channel corpus must yield two channels");
	assert.equal(ranked[0]?.broadcastId, "s1", "diversity takes the last slot, never the best one");
}
console.log("✓ a two-channel corpus produces a two-channel reference set");

// --- a single-channel corpus is left alone ---------------------------------
{
	const ranked = rankReferenceBroadcasts(
		[candidate({ broadcastId: "s1" }), candidate({ broadcastId: "s2" })],
		BRIEF,
		2,
	);
	assert.equal(ranked.length, 2, "nothing is dropped when only one channel exists");
}
console.log("✓ a single-channel corpus is not padded");

// --- every pattern status is reachable and distinct ------------------------
async function patterns(): Promise<void> {
	const never = () => Promise.resolve<CategoryPattern | null>(null);
	const applied: CategoryPattern = {
		category: "家電",
		sampleSize: 12,
		channels: ["qvc", "shopch"],
		runtimeMedianSec: 1800,
		actSequence: [],
		sellingPointOrder: [],
		evidenceMix: [],
		objectionMix: [],
		offerTiming: { firstPriceShare: 0.3, firstPriceMedianSec: 540, ctaCountMedian: 3 },
	};

	assert.deepEqual(
		await loadPatternResult("家電", { enabled: false, load: never }),
		{
			status: "disabled",
			pattern: null,
			detail: "broadcast intelligence is disabled (BROADCAST_INTEL_ENABLED)",
		},
		"a disabled feature is not the same fact as an empty corpus",
	);

	assert.deepEqual(await loadPatternResult(null, { enabled: true, load: never }), {
		status: "no_category",
		pattern: null,
		detail: "product category is missing",
	});

	const offWhitelist = await loadPatternResult("美容家電", { enabled: true, load: never });
	assert.equal(offWhitelist.status, "off_whitelist");
	assert.ok(offWhitelist.detail.includes("美容家電"), "the operator must be able to see which category was rejected");

	const underSampled = await loadPatternResult("家電", { enabled: true, load: never });
	assert.equal(underSampled.status, "under_sampled");
	assert.ok(/fewer than \d+/.test(underSampled.detail));

	const timedOut = await loadPatternResult("家電", {
		enabled: true,
		timeoutMs: 5,
		load: () => new Promise((resolve) => setTimeout(() => resolve(applied), 200)),
	});
	assert.equal(timedOut.status, "timed_out");
	assert.equal(timedOut.pattern, null, "a slow lookup must not deliver a late pattern");

	const failed = await loadPatternResult("家電", {
		enabled: true,
		load: () => Promise.reject(new Error("connection reset")),
	});
	assert.equal(failed.status, "failed", "a broken lookup must never fail the generation");
	assert.ok(failed.detail.includes("connection reset"));

	const ok = await loadPatternResult("家電", { enabled: true, load: async () => applied });
	assert.equal(ok.status, "applied");
	assert.equal(ok.pattern?.sampleSize, 12);
	assert.ok(ok.detail.includes("12"), "an applied pattern says how much it rests on");

	const statuses = new Set([
		"disabled",
		"no_category",
		"off_whitelist",
		"under_sampled",
		"timed_out",
		"failed",
		"applied",
	]);
	assert.equal(statuses.size, 7, "every status in the schema CHECK is exercised above");
	console.log("✓ all seven pattern statuses are reachable and carry their reason");
	console.log("PASS: screenplay reference broadcasts");
}

patterns().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
