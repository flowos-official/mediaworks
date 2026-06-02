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

// --- strategy pool: applyFilters excludes excluded-channel rows ---
import { __test as poolTest, type PoolRow } from "../lib/strategy/pool-query";

function row(over: Partial<PoolRow>): PoolRow {
	return {
		id: "00000000-0000-0000-0000-000000000000",
		name: "x",
		product_url: "https://example.com",
		price_jpy: null,
		category: null,
		seed_keyword: "kw",
		source: "tv_channel",
		tv_fit_score: 50,
		tv_fit_reason: null,
		tv_channel_source: null,
		tv_tier: 0,
		context: "home_shopping",
		user_action: null,
		c_package: null,
		enrichment_status: "completed",
		review_count: null,
		review_avg: null,
		seller_name: null,
		broadcast_tag: null,
		thumbnail_url: null,
		created_at: new Date().toISOString(),
		tv_evidence: null,
		...over,
	};
}

const filtered = poolTest.applyFilters(
	[
		row({ id: "11111111-1111-1111-1111-111111111111", tv_channel_source: "txd" }),
		row({ id: "22222222-2222-2222-2222-222222222222", tv_channel_source: "japanet" }),
	],
	{ context: "home_shopping" },
);
check("applyFilters drops txd row", filtered.length === 1);
check(
	"applyFilters keeps japanet row",
	filtered[0]?.tv_channel_source === "japanet",
);

console.log(`[test:txd-exclusion] ${passed} assertions passed`);
