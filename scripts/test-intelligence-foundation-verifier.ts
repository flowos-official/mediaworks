import assert from "node:assert/strict";

import {
	isLegacyFoundationEligible,
	passesRecentCategoryCoverage,
} from "./verify-intelligence-foundation";

assert.equal(
	passesRecentCategoryCoverage(18, 19),
	false,
	"18/19 is below the raw 95% threshold even though rounded display is 95%",
);
assert.equal(
	passesRecentCategoryCoverage(19, 20),
	true,
	"19/20 meets the exact 95% threshold",
);
assert.equal(
	passesRecentCategoryCoverage(0, 0),
	false,
	"an empty eligible denominator never passes",
);

const eligible = {
	source: "tv_channel",
	userAction: null,
	tvChannelSource: "qvc",
} as const;
assert.equal(isLegacyFoundationEligible(eligible), true);
assert.equal(
	isLegacyFoundationEligible({ ...eligible, source: "rakuten" }),
	false,
	"non-tv_channel Discovery candidates stay outside the bounded foundation",
);
assert.equal(
	isLegacyFoundationEligible({ ...eligible, userAction: "rejected" }),
	false,
	"inactive user actions stay outside the recent-active denominator",
);
assert.equal(
	isLegacyFoundationEligible({ ...eligible, tvChannelSource: "rakuraku" }),
	false,
	"disconnected OA aliases stay outside the declared source scope",
);

console.log("PASS: intelligence foundation verifier boundaries");
