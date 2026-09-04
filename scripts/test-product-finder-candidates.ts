import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assembleCandidate, type EvidenceRow } from "../lib/product-finder/candidates";

const product = { id: "cp-1", display_name: "静音ブレンダー", normalized_category: "家電" };

function ev(over: Partial<EvidenceRow> & Pick<EvidenceRow, "predicate">): EvidenceRow {
	return {
		id: `ev-${over.predicate}-${over.evidence_class ?? "x"}-${over.observed_at ?? "0"}`,
		subject_id: "cp-1",
		value_json: null,
		value_state: "known",
		evidence_class: "proxy",
		confidence: 0.8,
		observed_at: "2026-09-01T00:00:00Z",
		revoked_at: null,
		...over,
	};
}

// --- evidence class is preserved, never upgraded ---------------------------
// The whole point of the ledger is that a competitor's sales copy and a
// measured price are different kinds of thing. If assembly flattened them the
// ranking would treat marketing as measurement.
{
	const c = assembleCandidate(product, [
		ev({ predicate: "price_jpy", value_json: 12800, evidence_class: "verified" }),
		ev({ predicate: "tv_airing_count", value_json: 7, evidence_class: "proxy" }),
		ev({ predicate: "review_count", value_json: 240, evidence_class: "proxy" }),
		ev({ predicate: "seller_claim", value_json: "累計10万台突破", evidence_class: "source_claim" }),
	]);
	assert.equal(c.signals.priceJpy?.evidenceClass, "verified");
	assert.equal(c.signals.tvAirings?.evidenceClass, "proxy");
	assert.equal(c.signals.reviewCount?.evidenceClass, "proxy");
	assert.equal(c.signals.sellerSalesClaim?.evidenceClass, "source_claim");
	// A seller's claim must never be reachable under a name that reads as fact.
	assert.equal("actualSales" in c.signals, false);
	assert.equal("unitsSold" in c.signals, false);
}
console.log("✓ evidence class survives assembly and a claim never becomes a sale");

// --- unknown is absence, not zero ------------------------------------------
// Every review_count row in the live table is value_state 'unknown'. Read as 0
// this would rank a product with no review data below one with genuinely zero
// reviews, and the ranking would be reporting an artefact of collection.
{
	const c = assembleCandidate(product, [
		ev({ predicate: "review_count", value_json: null, value_state: "unknown" }),
		ev({ predicate: "price_jpy", value_json: null, value_state: "unknown", evidence_class: "verified" }),
	]);
	assert.equal(c.signals.reviewCount, undefined, "an unknown review count yields no signal");
	assert.equal(c.signals.priceJpy, undefined, "an unknown price yields no signal");
	// It still counts as evidence consulted — coverage must reflect that we
	// looked and found nothing, which is different from never having looked.
	assert.equal(c.evidenceIds.length, 2);
}
console.log("✓ an unknown value produces no signal but still counts as consulted");

// --- precedence -------------------------------------------------------------
// internal_input > verified > source_claim > proxy > inferred, then confidence,
// then observation time.
{
	const c = assembleCandidate(product, [
		ev({ predicate: "price_jpy", value_json: 9000, evidence_class: "proxy", observed_at: "2026-09-03T00:00:00Z" }),
		ev({ predicate: "price_jpy", value_json: 12800, evidence_class: "verified", observed_at: "2026-09-01T00:00:00Z" }),
	]);
	assert.equal(c.signals.priceJpy?.value, 12800, "a verified older price beats a newer proxy");
}
{
	const c = assembleCandidate(product, [
		ev({ predicate: "price_jpy", value_json: 100, evidence_class: "verified", confidence: 0.5 }),
		ev({ predicate: "price_jpy", value_json: 200, evidence_class: "verified", confidence: 0.9 }),
	]);
	assert.equal(c.signals.priceJpy?.value, 200, "within a class, higher confidence wins");
}
{
	const c = assembleCandidate(product, [
		ev({ predicate: "price_jpy", value_json: 100, evidence_class: "verified", observed_at: "2026-08-01T00:00:00Z" }),
		ev({ predicate: "price_jpy", value_json: 200, evidence_class: "verified", observed_at: "2026-09-01T00:00:00Z" }),
	]);
	assert.equal(c.signals.priceJpy?.value, 200, "at equal class and confidence, the newer observation wins");
}
console.log("✓ class outranks confidence, which outranks recency");

// --- internal profit is internal only --------------------------------------
{
	const c = assembleCandidate(product, [
		ev({ predicate: "gross_profit_jpy", value_json: 3400, evidence_class: "internal_input" }),
		ev({ predicate: "gross_margin_pct", value_json: 27, evidence_class: "internal_input" }),
	]);
	assert.equal(c.signals.internalProfitJpy?.value, 3400);
	assert.equal(c.signals.internalMarginRate?.value, 27);
	assert.equal(c.signals.internalProfitJpy?.evidenceClass, "internal_input");
}
{
	// A competitor's claimed profit is not ours, whatever the predicate says.
	const c = assembleCandidate(product, [
		ev({ predicate: "gross_profit_jpy", value_json: 999999, evidence_class: "source_claim" }),
	]);
	assert.equal(c.signals.internalProfitJpy, undefined, "only internal_input fills an internal figure");
}
console.log("✓ internal profit accepts internal_input alone");

// --- stale and revoked ------------------------------------------------------
{
	const c = assembleCandidate(product, [
		ev({ predicate: "price_jpy", value_json: 100, value_state: "stale", evidence_class: "verified" }),
	]);
	assert.equal(c.signals.priceJpy, undefined, "a stale row is not a current value");
}
{
	// revoked_at lands with the controlled-inputs migration; assembly must
	// already honour it, or the first rollback would silently keep applying.
	const c = assembleCandidate(product, [
		ev({ predicate: "price_jpy", value_json: 100, evidence_class: "verified", revoked_at: "2026-09-02T00:00:00Z" }),
	]);
	assert.equal(c.signals.priceJpy, undefined, "a revoked row is not a current value");
}
console.log("✓ stale and revoked evidence is excluded");

// --- non-numeric guards -----------------------------------------------------
{
	const c = assembleCandidate(product, [
		ev({ predicate: "price_jpy", value_json: "たぶん12800円", evidence_class: "verified" }),
		ev({ predicate: "tv_airing_count", value_json: Number.NaN, evidence_class: "proxy" }),
	]);
	assert.equal(c.signals.priceJpy, undefined, "prose is not a price");
	assert.equal(c.signals.tvAirings, undefined, "NaN is not a count");
}
console.log("✓ a numeric signal rejects non-numeric evidence");

// --- static no-network guard ------------------------------------------------
// The service's defining property is that it does not search. A stray import
// is far easier to catch here than in a bill.
{
	const src = readFileSync("lib/product-finder/candidates.ts", "utf8");
	for (const forbidden of ["@/lib/brave", "@/lib/rakuten", "@google/genai", "fetch(", "axios", "undici"]) {
		assert.ok(!src.includes(forbidden), `candidates.ts must not reference ${forbidden}`);
	}
}
console.log("✓ the candidate loader reaches no network");

console.log("PASS: product finder candidates");
