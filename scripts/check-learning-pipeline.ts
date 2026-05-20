import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
	const { getServiceClient } = await import("../lib/supabase");
	const sb = getServiceClient();

	console.log("=== learning_state ===");
	const { data: states, error: stateErr } = await sb
		.from("learning_state")
		.select("context, exploration_ratio, feedback_sample_size, is_cold_start, updated_at")
		.order("context");
	if (stateErr) console.error("learning_state error:", stateErr.message);
	else console.table(states);

	console.log("\n=== learning_insights (recent 8 rows) ===");
	const { data: insights, error: insErr } = await sb
		.from("learning_insights")
		.select(
			"week_start, context, sourced_count, rejected_count, created_at",
		)
		.order("week_start", { ascending: false })
		.limit(8);
	if (insErr) console.error("learning_insights error:", insErr.message);
	else console.table(insights);

	console.log("\n=== discovery_runs (last 7 days, exploration_ratio sample) ===");
	const sevenDaysAgo = new Date();
	sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
	const { data: runs, error: runErr } = await sb
		.from("discovery_runs")
		.select("run_at, context, status, exploration_ratio, produced_count")
		.gte("run_at", sevenDaysAgo.toISOString())
		.order("run_at", { ascending: false })
		.limit(10);
	if (runErr) console.error("discovery_runs error:", runErr.message);
	else console.table(runs);

	console.log("\n=== discovered_products feedback (last 30 days, by user_action) ===");
	const thirtyDaysAgo = new Date();
	thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
	const { data: actions, error: actErr } = await sb
		.from("discovered_products")
		.select("user_action")
		.not("user_action", "is", null)
		.gte("action_at", thirtyDaysAgo.toISOString());
	if (actErr) console.error("discovered_products error:", actErr.message);
	else {
		const counts = (actions ?? []).reduce<Record<string, number>>((acc, r) => {
			const key = r.user_action ?? "null";
			acc[key] = (acc[key] ?? 0) + 1;
			return acc;
		}, {});
		console.table(counts);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
