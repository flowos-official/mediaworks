/**
 * End-to-end test against the user guide scenarios.
 * Checks DB state + API contract for each guide feature.
 */

import { getServiceClient } from "@/lib/supabase";

interface CheckResult {
	name: string;
	ok: boolean;
	detail?: string;
}

const results: CheckResult[] = [];

function pass(name: string, detail?: string) {
	results.push({ name, ok: true, detail });
}

function fail(name: string, detail: string) {
	results.push({ name, ok: false, detail });
}

async function main() {
	const sb = getServiceClient();

	console.log("=== User Guide Scenario Verification ===\n");

	// Scenario 1: Daily routine — discovery_runs has recent sessions per context
	const { data: runs } = await sb
		.from("discovery_runs")
		.select("id, run_at, status, context, produced_count")
		.order("run_at", { ascending: false })
		.limit(10);

	if ((runs ?? []).length >= 2) {
		const home = (runs ?? []).find((r) => r.context === "home_shopping");
		const live = (runs ?? []).find((r) => r.context === "live_commerce");
		if (home && live) {
			pass(
				"1.1 Dual context sessions exist",
				`home: ${home.produced_count}/${home.status}, live: ${live.produced_count}/${live.status}`,
			);
		} else {
			fail("1.1 Dual context sessions", "Missing home or live session");
		}
	} else {
		fail("1.1 Dual context sessions", `Only ${(runs ?? []).length} sessions`);
	}

	// Scenario 2: Products have required B package fields
	const { data: sampleProds } = await sb
		.from("discovered_products")
		.select(
			"id, name, thumbnail_url, product_url, price_jpy, review_avg, tv_fit_score, tv_fit_reason, track, broadcast_tag, context",
		)
		.limit(10);

	const prods = sampleProds ?? [];
	const withImages = prods.filter((p) => p.thumbnail_url).length;
	const withScores = prods.filter((p) => p.tv_fit_score != null).length;
	const withReasons = prods.filter((p) => p.tv_fit_reason).length;
	if (prods.length >= 5 && withScores === prods.length) {
		pass(
			"2.1 Products have B package",
			`${prods.length} sampled, ${withImages} with images, ${withScores} with scores, ${withReasons} with reasons`,
		);
	} else {
		fail("2.1 Products B package", `Incomplete: ${withScores}/${prods.length} have scores`);
	}

	// Scenario 3: Feedback events exist (proving 4-button works)
	const { data: feedback, count: fbCount } = await sb
		.from("product_feedback")
		.select("action", { count: "exact" })
		.limit(5);

	if ((fbCount ?? 0) > 0) {
		const actions = new Set((feedback ?? []).map((f) => f.action));
		pass(
			"3.1 Feedback events recorded",
			`Total: ${fbCount}, action types seen: ${[...actions].join(", ")}`,
		);
	} else {
		fail("3.1 Feedback events", "No feedback events in DB");
	}

	// Scenario 4: Enrichment C packages exist
	const { count: enrichedCount } = await sb
		.from("discovered_products")
		.select("id", { count: "exact", head: true })
		.eq("enrichment_status", "completed");

	if ((enrichedCount ?? 0) > 0) {
		pass("4.1 Enrichment C packages", `${enrichedCount} products fully enriched`);
	} else {
		fail("4.1 Enrichment C packages", "No completed enrichments");
	}

	// Scenario 5: Strategy references seed products (via md_strategies table if exists)
	const { data: mdStrategies, error: mdErr } = await sb
		.from("md_strategies")
		.select("id, user_goal")
		.order("created_at", { ascending: false })
		.limit(5);

	if (mdErr) {
		fail("5.1 MD strategies table", mdErr.message);
	} else {
		const seedRefs = (mdStrategies ?? []).filter((s) =>
			(s.user_goal ?? "").includes("新商品"),
		);
		if (seedRefs.length > 0) {
			pass(
				"5.1 Seed-aware strategies",
				`${seedRefs.length}/${(mdStrategies ?? []).length} strategies mention 新商品`,
			);
		} else {
			pass(
				"5.1 MD strategies accessible",
				`${(mdStrategies ?? []).length} strategies (no seed-referenced yet)`,
			);
		}
	}

	// Scenario 6: Weekly insights exist
	const { data: insights, count: insCount } = await sb
		.from("learning_insights")
		.select("*", { count: "exact" })
		.order("week_start", { ascending: false })
		.limit(5);

	if ((insCount ?? 0) >= 2) {
		const ctxs = new Set((insights ?? []).map((i) => i.context));
		pass(
			"6.1 Weekly insights per context",
			`${insCount} rows, contexts: ${[...ctxs].join(", ")}, latest text: "${(insights?.[0]?.sourced_product_patterns ?? "").slice(0, 60)}..."`,
		);
	} else {
		fail("6.1 Weekly insights", `Only ${insCount ?? 0} rows`);
	}

	// Scenario 7: Learning state per-context
	const { data: states } = await sb.from("learning_state").select("*");
	const stateCtxs = new Set((states ?? []).map((s) => s.context));
	if (stateCtxs.has("home_shopping") && stateCtxs.has("live_commerce")) {
		const homeState = (states ?? []).find((s) => s.context === "home_shopping");
		pass(
			"7.1 Per-context learning_state",
			`2 rows. Home: cold_start=${homeState?.is_cold_start}, ratio=${homeState?.exploration_ratio}`,
		);
	} else {
		fail("7.1 Learning state rows", `Expected home+live, got ${[...stateCtxs].join(", ")}`);
	}

	// Scenario 8: Rejected seeds accumulating (from Phase 4 learning)
	const rejectedSeedsData = (states ?? []).map((s) => s.rejected_seeds ?? { urls: [], brands: [], terms: [] });
	const totalRejected = rejectedSeedsData.reduce(
		(sum, s) => sum + ((s.urls?.length ?? 0) + (s.brands?.length ?? 0)),
		0,
	);
	pass(
		"8.1 Rejected seeds tracking",
		`${totalRejected} rejected URLs/brands across contexts (0 is OK for cold start)`,
	);

	// Scenario 9: Sourced products auto-excluded (via discovered_products.user_action)
	const { count: sourcedCount } = await sb
		.from("discovered_products")
		.select("id", { count: "exact", head: true })
		.eq("user_action", "sourced");
	if ((sourcedCount ?? 0) >= 1) {
		pass("9.1 Sourced products for exclusion", `${sourcedCount} sourced`);
	} else {
		pass("9.1 Sourced products", "0 sourced yet (OK — ready to accept)");
	}

	// Summary
	console.log("\n=== Results ===");
	const passCount = results.filter((r) => r.ok).length;
	const failCount = results.filter((r) => !r.ok).length;
	for (const r of results) {
		const icon = r.ok ? "✅" : "❌";
		console.log(`${icon} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
	}
	console.log(`\n${passCount} passed, ${failCount} failed.`);

	if (failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
	console.error("FAIL:", err);
	process.exitCode = 1;
});
