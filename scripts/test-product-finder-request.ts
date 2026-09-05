import assert from "node:assert/strict";
import { parseProductFinderQuery } from "../lib/product-finder/request";

// Defaults are explicit values, not absent keys: the run persists query_json
// verbatim, and "the operator left it blank" must read the same way in every
// stored run.
assert.deepEqual(parseProductFinderQuery({ category: "家電", targetCustomer: "50代女性" }), {
	category: "家電",
	targetCustomer: "50代女性",
	priceMinJpy: undefined,
	priceMaxJpy: undefined,
	targetMarginRate: undefined,
	desiredFeatures: [],
	excludedTerms: [],
	limit: 10,
	mode: "stored_only",
});
console.log("✓ a minimal query fills its own defaults");

// The one mode this service has. `supplemented` exists in a later plan and is
// reachable only through its own endpoint; accepting it here would let the
// stored-only surface make external calls by request parameter.
assert.throws(() => parseProductFinderQuery({ category: "家電", mode: "supplemented" }), /mode/i);
assert.doesNotThrow(() => parseProductFinderQuery({ category: "家電", mode: "stored_only" }));
console.log("✓ only stored_only is accepted as a mode");

// Strict, not stripping. A silently dropped field is a request the operator
// believes was honoured and was not.
assert.throws(() => parseProductFinderQuery({ category: "家電", surpriseField: true }));
console.log("✓ unknown fields are rejected, never silently dropped");

// Bounds.
assert.throws(() => parseProductFinderQuery({ limit: 4 }), /limit/i);
assert.throws(() => parseProductFinderQuery({ limit: 31 }), /limit/i);
assert.equal(parseProductFinderQuery({ limit: 5 }).limit, 5);
assert.equal(parseProductFinderQuery({ limit: 30 }).limit, 30);
assert.throws(() => parseProductFinderQuery({ priceMinJpy: -1 }), /price/i);
assert.throws(() => parseProductFinderQuery({ priceMinJpy: 1.5 }), /price/i);
assert.throws(() => parseProductFinderQuery({ targetMarginRate: 101 }), /margin/i);
assert.doesNotThrow(() => parseProductFinderQuery({ targetMarginRate: 0 }));
assert.doesNotThrow(() => parseProductFinderQuery({ targetMarginRate: 100 }));
console.log("✓ numeric bounds are enforced at the edge");

// A price band that excludes everything is a mistake worth catching here
// rather than returning zero candidates and looking like empty data.
assert.throws(
	() => parseProductFinderQuery({ priceMinJpy: 5000, priceMaxJpy: 1000 }),
	/price/i,
);
console.log("✓ an inverted price band is rejected");

// Text limits, applied after trimming so whitespace cannot buy length.
assert.equal(parseProductFinderQuery({ category: "  家電  " }).category, "家電");
assert.throws(() => parseProductFinderQuery({ category: "あ".repeat(201) }), /200/);
assert.doesNotThrow(() => parseProductFinderQuery({ category: `${"あ".repeat(200)}  ` }));
assert.throws(
	() => parseProductFinderQuery({ desiredFeatures: Array.from({ length: 21 }, (_, i) => `f${i}`) }),
	/20/,
);
console.log("✓ text is trimmed and bounded");

// An empty string is not a filter. Left as "" it would be sent to the database
// as an exact-match on the empty string and quietly return nothing.
assert.equal(parseProductFinderQuery({ category: "   " }).category, undefined);
assert.deepEqual(parseProductFinderQuery({ desiredFeatures: ["a", "  ", "b"] }).desiredFeatures, ["a", "b"]);
console.log("✓ blank text is absence, not an empty-string filter");

console.log("PASS: product finder request");
