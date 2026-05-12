import assert from "node:assert/strict";
import { __test } from "@/lib/md-strategy";

// Test the pure decision helper, not the network. We expose
// `decideDiscoveryStrategy` which returns { strategy, fillNeeded } from a pool size.
const cases = [
	{ poolSize: 0,  target: 20, expected: { strategy: "fresh_only" as const, fillNeeded: 20 } },
	{ poolSize: 5,  target: 20, expected: { strategy: "pool_filled" as const, fillNeeded: 15 } },
	{ poolSize: 20, target: 20, expected: { strategy: "pool_only" as const, fillNeeded: 0 } },
	{ poolSize: 35, target: 20, expected: { strategy: "pool_only" as const, fillNeeded: 0 } },
	{ poolSize: 8,  target: 12, expected: { strategy: "pool_filled" as const, fillNeeded: 4 } },
];

for (const c of cases) {
	const got = __test.decideDiscoveryStrategy(c.poolSize, c.target);
	assert.deepEqual(got, c.expected, `pool=${c.poolSize} target=${c.target}`);
}

// R8: pool target sizes
assert.equal(__test.poolTargetSize(true), 30, "lightweight target = 30");
assert.equal(__test.poolTargetSize(false), 12, "full target = 12");

console.log("PASS: discover pool-first decision rules");
