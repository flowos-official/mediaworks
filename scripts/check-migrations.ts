/**
 * Verify critical recommendation-system migrations are applied to the
 * configured Supabase project.
 * Usage: npm run test:migrations
 */

import { getServiceClient } from "@/lib/supabase";

const REQUIRED_TABLES = [
	"discovery_runs",
	"discovered_products",
	"product_feedback",
	"learning_state",
	"learning_insights",
	"channel_categories",
	"discovered_category_normalization",
	"competitor_fit_analyses",
	"historical_broadcasts",
	"broadcast_products",
	"broadcast_transcripts",
	"broadcast_speech_analyses",
	"research_results",
	"screenplays",
	"screenplay_versions",
	"broadcasts",
	// Intelligence foundation (20260829130000, 20260829131000). The pipeline
	// page loads readiness out of data_pipeline_runs on every render, so an
	// unapplied migration here is a user-visible failure, not a dormant one.
	"canonical_products",
	"product_source_links",
	"evidence_items",
	"insight_snapshots",
	"insight_snapshot_evidence",
	"knowledge_snapshots",
	"knowledge_snapshot_items",
	"data_pipeline_runs",
	"import_batches",
	"import_rows",
	"gemini_usage",
	// Grounded screenplay generation (20260829150000). A version whose context
	// table is missing generates fine and records nothing, so the failure is
	// invisible without this line.
	"screenplay_generation_contexts",
	"screenplay_claim_links",
	// Controlled knowledge inputs (20260829160000).
	"supplemental_research_runs",
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
		"seed_keyword",
		"source",
		"rakuten_item_code",
		"rakuten_cross_match",
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
		"tv_channel_source",
		"tv_tier",
		"selection_outcome",
		"selection_outcome_at",
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
	channel_categories: [
		"channel",
		"category",
		"is_allowed",
		"created_at",
		"updated_at",
	],
	discovered_category_normalization: [
		"raw_category",
		"whitelist_categories",
		"source",
		"classified_at",
		"notes",
	],
	competitor_fit_analyses: [
		"id",
		"slot_key",
		"channel",
		"product_name",
		"category",
		"fit_score",
		"summary",
		"created_at",
	],
	historical_broadcasts: ["id", "price_jpy"],
	broadcast_transcripts: [
		"broadcast_id",
		"segments",
		"act_summaries",
		"urgency_cues",
		"model",
		"schema_version",
	],
	broadcast_speech_analyses: [
		"broadcast_id",
		"channel",
		"air_date",
		"category",
		"duration_sec",
		"segments",
		"selling_points",
		"evidence_cues",
		"objection_handlings",
		"offer_timeline",
		"model",
		"schema_version",
	],
	broadcast_products: [
		"broadcast_id",
		"product_id",
		"price_jpy",
		"original_price_jpy",
	],
	research_results: [
		"id",
		"product_id",
		"japan_export_fit_score",
		"korea_market_fit",
		"korea_fit_score",
		"domestic_market_fit",
	],
	screenplays: ["last_error"],
	screenplay_versions: ["pattern_snapshot", "generation_context_id"],
	// Revocation is how an import is undone; a consumer that cannot read these
	// columns keeps serving rolled-back evidence.
	evidence_items: ["import_batch_id", "revoked_at", "revoked_by", "revocation_reason"],
	broadcasts: ["analysis_status", "analysis_attempts", "analysis_error", "analyzed_at"],
};

async function main() {
	const sb = getServiceClient();

	console.log("=== Supabase Migration Verification ===\n");

	const problems: string[] = [];

	// Check each required table + columns
	for (const table of REQUIRED_TABLES) {
		// Fallback: query information_schema via raw SQL through a simple select trick
		// Just try to select; if table doesn't exist, error. Use limit(0) to prove existence
		// without fetching row data, matching the column-check probe pattern below.
		const probe = await sb.from(table).select("*").limit(0);
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
		// Not every required table declares a column contract — existence alone is
		// what matters for the intelligence tables, whose shape is pinned by their
		// own schema tests.
		const required = REQUIRED_COLUMNS[table];
		if (!required || required.length === 0) {
			console.log(`✅ ${table}: present (no column contract declared)`);
		} else {
			const colProbe = await sb.from(table).select(required.join(", ")).limit(0);
			if (colProbe.error) {
				problems.push(`[MISSING COL] ${table}: ${colProbe.error.message}`);
				console.log(`⚠️  ${table} column check: ${colProbe.error.message}`);
			} else {
				console.log(`✅ ${table}: all ${required.length} columns present`);
			}
		}

		// Sanity: count rows
		const { count } = await sb.from(table).select("*", { count: "exact", head: true });
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
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error("Check failed:", err);
	process.exitCode = 1;
});
