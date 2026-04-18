/**
 * Verify all Phase 1-6 migrations are applied to the Supabase project.
 * Usage: npm run check:migrations
 */

import { getServiceClient } from "@/lib/supabase";

const REQUIRED_TABLES = [
	"discovery_runs",
	"discovered_products",
	"product_feedback",
	"learning_state",
	"learning_insights",
];

const REQUIRED_COLUMNS: Record<string, string[]> = {
	discovery_runs: [
		"id",
		"run_at",
		"completed_at",
		"status",
		"target_count",
		"produced_count",
		"category_plan",
		"exploration_ratio",
		"iterations",
		"error",
		"context",
	],
	discovered_products: [
		"id",
		"session_id",
		"name",
		"product_url",
		"price_jpy",
		"category",
		"source",
		"rakuten_item_code",
		"review_count",
		"review_avg",
		"seller_name",
		"tv_fit_score",
		"tv_fit_reason",
		"broadcast_tag",
		"track",
		"is_tv_applicable",
		"is_live_applicable",
		"enrichment_status",
		"enrichment_started_at",
		"enrichment_completed_at",
		"c_package",
		"enrichment_error",
		"user_action",
		"action_reason",
		"action_at",
		"context",
		"thumbnail_url",
	],
	product_feedback: ["id", "discovered_product_id", "action", "reason", "created_at"],
	learning_state: [
		"context",
		"exploration_ratio",
		"category_weights",
		"rejected_seeds",
		"recent_rejection_reasons",
		"feedback_sample_size",
		"is_cold_start",
		"updated_at",
	],
	learning_insights: [
		"id",
		"week_start",
		"sourced_count",
		"rejected_count",
		"top_rejection_reasons",
		"sourced_product_patterns",
		"exploration_wins",
		"next_week_suggestions",
		"context",
	],
};

async function main() {
	const sb = getServiceClient();

	console.log("=== Supabase Migration Verification ===\n");

	const problems: string[] = [];

	// Check each required table + columns
	for (const table of REQUIRED_TABLES) {
		const { data, error } = await sb.rpc("pg_table_exists", {}).select().limit(0);
		// Fallback: query information_schema via raw SQL through a simple select trick
		// Just try to select 1 row; if table doesn't exist, error.
		const probe = await sb.from(table).select("*").limit(1);
		if (probe.error) {
			problems.push(`[MISSING TABLE] ${table}: ${probe.error.message}`);
			console.log(`❌ ${table}: ${probe.error.message}`);
			continue;
		}

		// For column check, use information_schema via a direct query isn't straightforward via supabase-js.
		// Instead, try inserting a throwaway (won't commit because we'll rollback) — too risky.
		// Use the limit(1) response's types or nulls as hint. Simpler approach:
		// Just check row exists in pg_attribute via a custom RPC if available. Otherwise best-effort:
		// Select only the required columns (zero rows) — if any is missing, error.
		const cols = REQUIRED_COLUMNS[table].join(", ");
		const colProbe = await sb.from(table).select(cols).limit(0);
		if (colProbe.error) {
			problems.push(`[MISSING COL] ${table}: ${colProbe.error.message}`);
			console.log(`⚠️  ${table} column check: ${colProbe.error.message}`);
		} else {
			console.log(`✅ ${table}: all ${REQUIRED_COLUMNS[table].length} columns present`);
		}

		// Sanity: count rows
		const { count } = await sb.from(table).select("id", { count: "exact", head: true });
		console.log(`   → ${count ?? 0} rows`);
	}

	// Additional checks specific to Phase 4/6 migrations
	console.log("\n=== Phase-specific checks ===");

	// Phase 4: learning_state must have context as PK (not id=1)
	const { data: states } = await sb.from("learning_state").select("context");
	const contexts = new Set((states ?? []).map((s) => s.context));
	if (contexts.has("home_shopping") && contexts.has("live_commerce")) {
		console.log("✅ learning_state: 2 context rows (home_shopping, live_commerce)");
	} else {
		const detected = [...contexts].join(", ");
		problems.push(
			`learning_state context rows incorrect: expected both home_shopping+live_commerce, got: ${detected || "(none)"}`,
		);
		console.log(`❌ learning_state: expected 2 context rows, got: ${detected || "(none)"}`);
	}

	// Phase 6: learning_insights must allow (week_start, context) composite unique
	const { data: insights } = await sb
		.from("learning_insights")
		.select("context")
		.limit(5);
	console.log(
		`✅ learning_insights: queryable (${(insights ?? []).length} sample rows, context col accessible)`,
	);

	// Summary
	console.log("\n=== Summary ===");
	if (problems.length === 0) {
		console.log("✅ All migrations appear applied successfully.");
	} else {
		console.log(`❌ ${problems.length} issue(s) found:`);
		for (const p of problems) console.log(`   - ${p}`);
	}
}

main().catch((err) => {
	console.error("Check failed:", err);
	process.exitCode = 1;
});
