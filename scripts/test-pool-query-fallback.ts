import assert from "node:assert/strict";
import { __test as poolTest } from "@/lib/strategy/pool-query";
import { __test as discoverTest } from "@/lib/md-strategy";

// Pool decision sanity — already covered, but verify both modules align.
const lwTarget = discoverTest.poolTargetSize(true);
const fullTarget = discoverTest.poolTargetSize(false);
assert.equal(lwTarget, 30);
assert.equal(fullTarget, 12);

// Decision crosswalk
const d1 = discoverTest.decideDiscoveryStrategy(0, lwTarget);
assert.equal(d1.strategy, "fresh_only");
assert.equal(d1.fillNeeded, lwTarget);

const d2 = discoverTest.decideDiscoveryStrategy(15, lwTarget);
assert.equal(d2.strategy, "pool_filled");
assert.equal(d2.fillNeeded, lwTarget - 15);

const d3 = discoverTest.decideDiscoveryStrategy(lwTarget + 5, lwTarget);
assert.equal(d3.strategy, "pool_only");
assert.equal(d3.fillNeeded, 0);

// Verify poolTest.applyFilters is exported (smoke check — full filter coverage in test-pool-query)
assert.equal(typeof poolTest.applyFilters, "function", "applyFilters export present");

console.log("PASS: pool-query + discover decision integration");
