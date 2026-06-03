/**
 * Live integration: ShopCh forward scrape returns today + future slots.
 * Tolerates the busy page (rate-limit) as a skip, not a failure.
 * Run: npm run test:shopch-forward
 */
import assert from "node:assert";
import { refreshShopChForwardRange } from "../lib/broadcasts/shopch-forward";

async function main() {
	// today + 2 days
	const summary = await refreshShopChForwardRange(2);
	console.log("[test:shopch-forward] summary:", JSON.stringify(summary));

	const busyOnly =
		summary.succeeded === 0 &&
		summary.errors.every((e) => /busy|集中|rate/i.test(e.error));
	if (busyOnly) {
		console.log("[test:shopch-forward] SKIPPED — shopch busy page (rate limited)");
		return;
	}

	assert.ok(summary.succeeded > 0, "at least one date scraped ok");
	assert.ok(summary.totalSlots > 0, "at least one ShopCh slot found across today..+2");
	console.log("[test:shopch-forward] PASS");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
