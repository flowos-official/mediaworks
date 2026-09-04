import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rankStoredCandidates } from "../lib/product-finder/ranking";
import type { StoredCandidate, StoredSignal } from "../lib/product-finder/candidates";
import { parseProductFinderQuery } from "../lib/product-finder/request";

const query = parseProductFinderQuery({ category: "家電" });

function sig<T>(value: T, over: Partial<StoredSignal<T>> = {}): StoredSignal<T> {
	return {
		value,
		evidenceClass: "proxy",
		confidence: 0.8,
		observedAt: "2026-09-01T00:00:00Z",
		evidenceItemId: `ev-${String(value)}`,
		...over,
	};
}

function candidate(
	canonicalProductId: string,
	signals: StoredCandidate["signals"],
): StoredCandidate {
	return {
		canonicalProductId,
		name: canonicalProductId,
		category: "家電",
		evidenceIds: Object.values(signals).map((s) => s!.evidenceItemId),
		signals,
	};
}

const fixtures: StoredCandidate[] = [
	candidate("known-profitable", {
		priceJpy: sig(12800, { evidenceClass: "verified" }),
		tvAirings: sig(9),
		recentAirings: sig(4),
		reviewCount: sig(310),
		internalProfitJpy: sig(3400, { evidenceClass: "internal_input", confidence: 0.95 }),
		internalMarginRate: sig(27, { evidenceClass: "internal_input", confidence: 0.95 }),
		broadcastPatternSample: sig(40, { evidenceClass: "inferred" }),
	}),
	candidate("no-cost", {
		priceJpy: sig(9800, { evidenceClass: "verified" }),
		tvAirings: sig(12),
		recentAirings: sig(6),
		reviewCount: sig(520),
		broadcastPatternSample: sig(50, { evidenceClass: "inferred" }),
	}),
	candidate("thin", {
		tvAirings: sig(1),
	}),
	candidate("empty", {}),
];

const ranked = rankStoredCandidates(fixtures, query);
const byId = (id: string) => ranked.find((x) => x.canonicalProductId === id)!;

// --- profit stays unknown without internal data ----------------------------
assert.equal(byId("no-cost").expectedContributionProfitJpy, null);
assert.equal(byId("no-cost").axes.find((a) => a.key === "profitability")!.status, "unknown");
assert.equal(byId("no-cost").axes.find((a) => a.key === "profitability")!.normalized, null);
console.log("✓ no internal cost data means profit is unknown, not zero");

// A product with more demand signal than the profitable one must still not
// out-rank it: a known contribution profit is the stronger fact.
assert.equal(ranked[0]!.canonicalProductId, "known-profitable");
assert.equal(byId("known-profitable").expectedContributionProfitJpy, 3400);
assert.equal(byId("known-profitable").axes.find((a) => a.key === "profitability")!.status, "measured");
console.log("✓ a known contribution profit ranks ahead of a richer proxy profile");

// --- index bounds and spread ------------------------------------------------
assert.ok(ranked.every((x) => x.opportunityIndex >= 0 && x.opportunityIndex <= 1));
assert.ok(new Set(ranked.map((x) => x.opportunityIndex)).size > 1, "a flat index ranks nothing");
console.log("✓ the opportunity index is bounded and actually discriminates");

// --- an axis with no evidence is unknown, never 0 --------------------------
{
	const empty = byId("empty");
	for (const axis of empty.axes) {
		assert.equal(axis.status, "unknown", `${axis.key} must be unknown with no evidence`);
		assert.equal(axis.normalized, null, `${axis.key} must carry no number when unknown`);
	}
	assert.equal(empty.confidence.coverage, 0);
	assert.equal(empty.confidence.level, "low");
	// Nothing known must not masquerade as a middling opportunity.
	assert.equal(empty.opportunityIndex, 0);
}
console.log("✓ a candidate with no evidence scores unknown across every axis");

// --- axes carry the class that produced them -------------------------------
{
	const item = byId("known-profitable");
	assert.equal(item.axes.find((a) => a.key === "market_demand")!.status, "proxy");
	assert.equal(item.axes.find((a) => a.key === "profitability")!.status, "measured");
	// Every axis must name the evidence it used, or the UI cannot show its work.
	for (const axis of item.axes.filter((a) => a.status !== "unknown")) {
		assert.ok(axis.evidenceIds.length > 0, `${axis.key} must cite evidence`);
	}
}
console.log("✓ each axis reports its own evidence class and citations");

// --- determinism ------------------------------------------------------------
{
	const again = rankStoredCandidates([...fixtures].reverse(), query);
	assert.deepEqual(
		again.map((x) => x.canonicalProductId),
		ranked.map((x) => x.canonicalProductId),
		"ranking must not depend on input order",
	);
}
console.log("✓ ranking is order-independent");

// --- ranks are dense and 1-based -------------------------------------------
assert.deepEqual(ranked.map((x) => x.rank), [1, 2, 3, 4]);
console.log("✓ ranks are dense and 1-based");

// --- static guard against unknown-to-zero coercion -------------------------
// The single most likely way this file regresses is a `?? 0` reintroduced for
// convenience, which converts every gap in the ledger into a real low score.
{
	// Strip comments first. The guard is about what the code does; the file
	// explains WHY `?? 0` is forbidden, and scanning prose made the rule
	// unstatable in its own docs.
	const code = readFileSync("lib/product-finder/ranking.ts", "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
	assert.ok(!/\?\?\s*0\b/.test(code), "ranking.ts must not coerce a missing signal to 0");
	assert.ok(!/\|\|\s*0\b/.test(code), "ranking.ts must not coerce a falsy signal to 0");
	assert.ok(!/Number\(/.test(code), "ranking.ts must not use Number(), which maps null and '' to 0");
	// The subtler form: an axis summing its parts and letting an absent one
	// contribute 0. Parts are averaged over what exists instead.
	assert.ok(!/:\s*0\s*\)/.test(code), "an absent sub-signal must be skipped, not added as 0");
}
console.log("✓ no unknown-to-zero coercion in the ranking source");

console.log("PASS: product finder ranking");
