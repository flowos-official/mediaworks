/**
 * Unit assertions for txd discovery exclusion.
 * Run: npm run test:txd-exclusion
 */
import assert from "node:assert";
import {
	hasExcludedChannel,
	isDiscoverySearchable,
	TV_CHANNELS,
	EXCLUDED_DISCOVERY_SLUGS,
} from "../lib/discovery/tv-channels";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

// --- hasExcludedChannel: token match, no substring false positives ---
check("'txd' excluded", hasExcludedChannel("txd") === true);
check("'japanet,txd' excluded", hasExcludedChannel("japanet,txd") === true);
check("'txd,japanet' excluded", hasExcludedChannel("txd,japanet") === true);
check("'japanet' not excluded", hasExcludedChannel("japanet") === false);
check("'txdx' not excluded (no substring fp)", hasExcludedChannel("txdx") === false);
check("null not excluded", hasExcludedChannel(null) === false);
check("empty not excluded", hasExcludedChannel("") === false);

// --- registry sanity ---
check("txd is in EXCLUDED set", EXCLUDED_DISCOVERY_SLUGS.has("txd"));

// --- isDiscoverySearchable: txd blocked, others allowed ---
const txd = TV_CHANNELS.find((c) => c.slug === "txd")!;
const japanet = TV_CHANNELS.find((c) => c.slug === "japanet")!;
const qvc = TV_CHANNELS.find((c) => c.slug === "qvc")!;
check("txd NOT searchable", isDiscoverySearchable(txd) === false);
check("japanet searchable", isDiscoverySearchable(japanet) === true);
check("qvc NOT searchable (scraped)", isDiscoverySearchable(qvc) === false);

console.log(`[test:txd-exclusion] ${passed} assertions passed`);
