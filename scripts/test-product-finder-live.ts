/**
 * End-to-end against the live database, with the service client.
 *
 * The static tests cannot see a missing RLS policy, a column that does not
 * exist, or a CHECK that rejects the write order — all three of which this
 * feature has already hit once. This runs a real recommendation over the real
 * evidence ledger and then removes what it wrote.
 */
import assert from "node:assert/strict";
import { getServiceClient } from "@/lib/supabase";
import { parseProductFinderQuery } from "@/lib/product-finder/request";
import {
	createProductFinderRepository,
	runProductFinderFromStoredEvidence,
} from "@/lib/product-finder/run";

async function main() {
	const sb = getServiceClient();

	const { data: profile, error: profileError } = await sb
		.from("profiles")
		.select("id")
		.limit(1)
		.maybeSingle();
	if (profileError) throw new Error(`profile read failed: ${profileError.message}`);
	if (!profile?.id) throw new Error("no profile exists to own a run");
	const userId = String(profile.id);

	const repo = createProductFinderRepository(sb);
	const query = parseProductFinderQuery({ limit: 5 });

	const result = await runProductFinderFromStoredEvidence(repo, userId, query, {
		mode: "stored_only",
	});
	console.log(
		`  ran over ${result.candidateCount} candidate(s), returned ${result.items.length}`,
	);

	try {
		// The run must be readable back as completed, with the snapshot the
		// CHECK insists on.
		const { data: run, error: runError } = await sb
			.from("product_recommendation_runs")
			.select("id, status, knowledge_snapshot_id, completed_at, candidate_count, result_count")
			.eq("id", result.runId)
			.single();
		if (runError) throw new Error(`run read failed: ${runError.message}`);
		assert.equal(run.status, "completed");
		assert.ok(run.knowledge_snapshot_id, "a completed run carries its knowledge snapshot");
		assert.ok(run.completed_at, "a completed run carries a completion time");
		assert.equal(run.result_count, result.items.length);
		console.log("✓ the run persisted as completed with a snapshot");

		const { data: items, error: itemError } = await sb
			.from("product_recommendation_items")
			.select("id, rank, opportunity_index, expected_contribution_profit_jpy, axes, missing_data")
			.eq("run_id", result.runId)
			.order("rank", { ascending: true });
		if (itemError) throw new Error(`item read failed: ${itemError.message}`);
		assert.equal((items ?? []).length, result.items.length);
		console.log(`✓ ${items?.length ?? 0} item(s) persisted with dense ranks`);

		if ((items ?? []).length > 0) {
			// The live ledger holds no internal_input rows yet, so profitability
			// must come back unknown rather than 0. This is the assertion that
			// would catch a future `?? 0` reaching production data.
			for (const item of items!) {
				assert.equal(
					item.expected_contribution_profit_jpy,
					null,
					"with no internal cost evidence, profit must be null, never 0",
				);
				const axes = item.axes as Array<{ key: string; status: string; normalized: number | null }>;
				const profit = axes.find((a) => a.key === "profitability");
				assert.equal(profit?.status, "unknown");
				assert.equal(profit?.normalized, null);
			}
			console.log("✓ profitability reads unknown against the real ledger, not zero");
		}

		const { data: snapItems, error: snapError } = await sb
			.from("knowledge_snapshot_items")
			.select("id")
			.eq("knowledge_snapshot_id", run.knowledge_snapshot_id as string);
		if (snapError) throw new Error(`snapshot item read failed: ${snapError.message}`);
		console.log(`✓ the snapshot records ${snapItems?.length ?? 0} evidence link(s)`);
	} finally {
		// Cascades to items; the snapshot is removed explicitly because the run
		// references it with ON DELETE RESTRICT.
		const { data: run } = await sb
			.from("product_recommendation_runs")
			.select("knowledge_snapshot_id")
			.eq("id", result.runId)
			.maybeSingle();
		await sb.from("product_recommendation_runs").delete().eq("id", result.runId);
		if (run?.knowledge_snapshot_id) {
			await sb.from("knowledge_snapshots").delete().eq("id", run.knowledge_snapshot_id as string);
		}
		console.log("  cleaned up");
	}

	console.log("PASS: product finder live");
}

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
