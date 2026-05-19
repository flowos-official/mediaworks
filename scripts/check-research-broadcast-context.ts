// scripts/check-research-broadcast-context.ts
// Run: tsx scripts/check-research-broadcast-context.ts <category>
// Verifies that loadBroadcastContext returns real data from current DB.

import {
	loadBroadcastContext,
	formatBroadcastContextPrompt,
} from "../lib/research/competitor-context";

const category = process.argv[2];
if (!category) {
	console.error("Usage: tsx scripts/check-research-broadcast-context.ts <category>");
	process.exit(1);
}

async function main() {
	console.log(`Loading broadcast context for category: ${category}`);
	const ctx = await loadBroadcastContext(category);
	if (!ctx) {
		console.log("→ returned null (empty category)");
		return;
	}
	console.log(`Recent QVC+ShopCh: ${ctx.recentAirings.length}`);
	console.log(`OA: ${ctx.oaAirings.length}`);
	console.log(`competitor_fit_analyses: avg=${ctx.operatorFit.avg}, count=${ctx.operatorFit.count}`);
	console.log("\n--- Formatted prompt section ---");
	console.log(formatBroadcastContextPrompt(ctx));
}

main().catch((err) => {
	console.error("FAILED:", err);
	process.exit(1);
});
