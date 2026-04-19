/**
 * Verify category_seasonal_weights migration, compute factors, dump full
 * 12-month matrix per category for sanity-check, and persist to both context
 * rows. Run once after applying the migration and whenever sales_weekly is
 * refreshed.
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-seasonality.ts
 */

import { getServiceClient } from "@/lib/supabase";
import { computeCategorySeasonality } from "@/lib/discovery/learning";

async function main(): Promise<void> {
	const sb = getServiceClient();

	console.log("=== Step 1 · Verify column exists ===");
	const { data: rows, error } = await sb
		.from("learning_state")
		.select("context, category_seasonal_weights")
		.order("context");
	if (error) {
		console.error("SELECT failed:", error.message);
		process.exit(1);
	}
	for (const r of rows ?? []) {
		const keys = Object.keys(
			(r as { category_seasonal_weights?: Record<string, unknown> })
				.category_seasonal_weights ?? {},
		).length;
		console.log(
			`  ${(r as { context: string }).context}: ${keys} categories populated`,
		);
	}

	console.log("\n=== Step 2 · Compute seasonality from sales_weekly ===");
	const t0 = Date.now();
	const weights = await computeCategorySeasonality();
	const ms = Date.now() - t0;
	const cats = Object.keys(weights);
	console.log(`  computed ${cats.length} categories in ${ms}ms`);
	if (cats.length === 0) {
		console.warn("  ⚠️ empty — sales_weekly may lack usable rows");
		return;
	}

	const month = new Date(Date.now() + 9 * 3600 * 1000).getUTCMonth() + 1;
	console.log(`\n=== Step 3 · Full 12-month matrix (current JST month=${month}) ===`);
	const header =
		"  " +
		"category".padEnd(14) +
		" " +
		Array.from({ length: 12 }, (_, i) =>
			(i + 1 === month ? `[${i + 1}]` : String(i + 1)).padStart(4),
		).join(" ");
	console.log(header);
	for (const cat of cats) {
		const cells = Array.from({ length: 12 }, (_, i) => {
			const f = weights[cat][String(i + 1)] ?? 1.0;
			return f.toFixed(2).padStart(4);
		}).join(" ");
		console.log(`  ${cat.padEnd(14)} ${cells}`);
	}

	console.log("\n=== Step 4 · Persist to both context rows ===");
	for (const ctx of ["home_shopping", "live_commerce"] as const) {
		const { error: upErr } = await sb
			.from("learning_state")
			.update({
				category_seasonal_weights: weights,
				updated_at: new Date().toISOString(),
			})
			.eq("context", ctx);
		console.log(`  ${ctx}: ${upErr ? "❌ " + upErr.message : "✅ updated"}`);
	}
}

main().catch((err) => {
	console.error("VERIFY FAILED:", err);
	process.exit(1);
});
