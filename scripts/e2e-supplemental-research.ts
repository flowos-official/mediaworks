/**
 * End-to-end gate for explicit supplemental research, against the live
 * database.
 *
 * Providers are INJECTED rather than called for real. That is not a shortcut:
 * the adapters have their own contract test, a real Brave/Rakuten call would
 * make this gate flaky and cost search quota on every run, and everything this
 * file is here to prove is about the database path — that research writes
 * classified evidence, that the re-rank reads it back rather than ranking an
 * in-memory result, and above all that a failure leaves the operator's
 * original recommendation intact.
 *
 * Read-mostly: it creates two runs and deletes everything it created, in
 * dependency order.
 */
import assert from "node:assert/strict";
import { getServiceClient } from "@/lib/supabase";
import { parseProductFinderQuery } from "@/lib/product-finder/request";
import {
	createProductFinderRepository,
	runProductFinderFromStoredEvidence,
} from "@/lib/product-finder/run";
import {
	createSupplementRepository,
	runSupplementalResearch,
} from "@/lib/intelligence/supplement/run";
import type { SupplementProviderDeps } from "@/lib/intelligence/supplement/providers";

const STAMP = `e2e-supplement-${Date.now()}`;
const created = {
	supplementalRuns: [] as string[],
	recommendationRuns: [] as string[],
	snapshots: [] as string[],
};

function providers(over: Partial<SupplementProviderDeps> = {}): {
	deps: SupplementProviderDeps;
	calls: { brave: number; rakuten: number };
} {
	const calls = { brave: 0, rakuten: 0 };
	return {
		calls,
		deps: {
			async braveSearch() {
				calls.brave++;
				return [
					{ title: "累計突破", description: "累計10万台突破", url: `https://example.test/${STAMP}` },
				];
			},
			async rakutenSearch() {
				calls.rakuten++;
				return {
					items: [
						{
							rank: 1,
							itemName: "e2e item",
							itemPrice: 12_345,
							itemCaption: "",
							// Unique per run so cleanup can find exactly these rows.
							itemUrl: `https://item.rakuten.co.jp/${STAMP}/`,
							shopName: "e2e shop",
							reviewCount: 3,
							reviewAverage: 4.5,
						},
					],
				};
			},
			...over,
		},
	};
}

async function createStoredOnlyRun(userId: string): Promise<{ runId: string; canonicalProductId: string }> {
	const sb = getServiceClient();
	const result = await runProductFinderFromStoredEvidence(
		createProductFinderRepository(sb),
		userId,
		parseProductFinderQuery({ limit: 5 }),
		{ mode: "stored_only" },
	);
	created.recommendationRuns.push(result.runId);
	const { data: run } = await sb
		.from("product_recommendation_runs")
		.select("knowledge_snapshot_id")
		.eq("id", result.runId)
		.single();
	if (run?.knowledge_snapshot_id) created.snapshots.push(String(run.knowledge_snapshot_id));
	if (result.items.length === 0) throw new Error("the ledger holds no rankable product to supplement");
	return { runId: result.runId, canonicalProductId: result.items[0].canonicalProductId };
}

async function cleanup(): Promise<void> {
	const sb = getServiceClient();
	// Order matters: supplemental runs RESTRICT-reference recommendation runs,
	// which reference snapshots, whose items RESTRICT-reference evidence.
	for (const id of created.supplementalRuns) {
		await sb.from("supplemental_research_runs").delete().eq("id", id);
	}
	for (const id of created.recommendationRuns) {
		await sb.from("product_recommendation_runs").delete().eq("id", id);
	}
	for (const id of created.snapshots) {
		await sb.from("knowledge_snapshots").delete().eq("id", id);
	}
	const { data: evidence } = await sb
		.from("evidence_items")
		.delete()
		.like("source_url", `%${STAMP}%`)
		.select("id");
	console.log(
		`  cleaned up ${created.supplementalRuns.length} research run(s), ` +
			`${created.recommendationRuns.length} recommendation run(s), ${(evidence ?? []).length} evidence row(s)`,
	);
}

async function main(): Promise<void> {
	const sb = getServiceClient();
	const { data: profile } = await sb.from("profiles").select("id").limit(1).maybeSingle();
	if (!profile?.id) throw new Error("no profile exists to own a run");
	const userId = String(profile.id);

	try {
		// --- one gap, one provider, and a new ranking -----------------------
		const original = await createStoredOnlyRun(userId);
		const { data: before } = await sb
			.from("product_recommendation_runs")
			.select("status, mode, knowledge_snapshot_id, result_count")
			.eq("id", original.runId)
			.single();

		const { deps, calls } = providers();
		const result = await runSupplementalResearch(
			createSupplementRepository(sb, sb),
			deps,
			{
				recommendationRunId: original.runId,
				canonicalProductId: original.canonicalProductId,
				userId,
				gaps: ["current_price"],
			},
		);
		created.supplementalRuns.push(result.supplementalRunId);
		if (result.recommendationRunId !== original.runId) {
			created.recommendationRuns.unshift(result.recommendationRunId);
		}

		assert.equal(result.status, "completed");
		assert.equal(calls.brave, 0, "a price question must not spend a web search");
		assert.equal(calls.rakuten, 1);
		assert.ok(result.evidenceCount > 0, "the observation must reach the ledger");

		// The evidence is there, classified, and reachable by subject.
		const { data: written } = await sb
			.from("evidence_items")
			.select("predicate, evidence_class, value_json, unit, subject_id, revoked_at")
			.like("source_url", `%${STAMP}%`);
		assert.ok((written ?? []).length > 0, "supplemental evidence must be queryable afterwards");
		const price = (written ?? []).find((row) => row.predicate === "marketplace_price_jpy");
		assert.ok(price, "the price observation is stored under a predicate that names its source");
		assert.equal(price?.evidence_class, "verified");
		assert.equal(price?.value_json, 12_345);
		assert.equal(price?.subject_id, original.canonicalProductId);
		assert.equal(price?.revoked_at, null);

		// A new run, in supplemented mode, with its own snapshot.
		const { data: reranked } = await sb
			.from("product_recommendation_runs")
			.select("id, mode, status, knowledge_snapshot_id")
			.eq("id", result.recommendationRunId)
			.single();
		assert.equal(reranked?.mode, "supplemented", "the new run records that research preceded it");
		assert.equal(reranked?.status, "completed");
		assert.ok(reranked?.knowledge_snapshot_id);
		if (reranked?.knowledge_snapshot_id) created.snapshots.unshift(String(reranked.knowledge_snapshot_id));
		assert.notEqual(
			reranked?.knowledge_snapshot_id,
			before?.knowledge_snapshot_id,
			"a supplemented result must not reuse the stored-only snapshot",
		);

		// And the original is untouched — this is the property the whole design
		// is arranged around.
		const { data: after } = await sb
			.from("product_recommendation_runs")
			.select("status, mode, knowledge_snapshot_id, result_count")
			.eq("id", original.runId)
			.single();
		assert.deepEqual(after, before, "the original recommendation must be byte-identical afterwards");

		const { data: audit } = await sb
			.from("supplemental_research_runs")
			.select("status, requested_gaps, evidence_count, prior_knowledge_snapshot_id, result_recommendation_run_id")
			.eq("id", result.supplementalRunId)
			.single();
		assert.equal(audit?.status, "completed");
		assert.deepEqual(audit?.requested_gaps, ["current_price"], "the audit row records exactly what was asked");
		assert.equal(audit?.prior_knowledge_snapshot_id, before?.knowledge_snapshot_id);
		assert.equal(audit?.result_recommendation_run_id, result.recommendationRunId);

		console.log(
			`  [one-gap] research=${result.supplementalRunId.slice(0, 8)} evidence=${result.evidenceCount}` +
				` original=${original.runId.slice(0, 8)} reranked=${result.recommendationRunId.slice(0, 8)}`,
		);

		// --- total provider failure leaves the original usable ---------------
		const failing = providers({
			async braveSearch() {
				throw new Error("brave unavailable");
			},
			async rakutenSearch() {
				throw new Error("rakuten unavailable");
			},
		});
		const failed = await runSupplementalResearch(createSupplementRepository(sb, sb), failing.deps, {
			recommendationRunId: original.runId,
			canonicalProductId: original.canonicalProductId,
			userId,
			gaps: ["current_price", "seller_sales_claim"],
		});
		created.supplementalRuns.unshift(failed.supplementalRunId);

		assert.equal(failed.status, "failed");
		assert.equal(
			failed.recommendationRunId,
			original.runId,
			"a provider outage must hand back the result the operator already had",
		);
		assert.equal(failed.evidenceCount, 0);

		const { data: stillThere } = await sb
			.from("product_recommendation_runs")
			.select("status, mode, knowledge_snapshot_id, result_count")
			.eq("id", original.runId)
			.single();
		assert.deepEqual(stillThere, before, "and must not have touched it");

		const { data: failedAudit } = await sb
			.from("supplemental_research_runs")
			.select("status, error_code, result_recommendation_run_id")
			.eq("id", failed.supplementalRunId)
			.single();
		assert.equal(failedAudit?.status, "failed");
		assert.equal(failedAudit?.error_code, "all_gaps_failed");
		assert.equal(
			failedAudit?.result_recommendation_run_id,
			null,
			"a failed run must not point at a recommendation it did not produce",
		);

		console.log(`  [total-failure] research=${failed.supplementalRunId.slice(0, 8)} original preserved`);
	} finally {
		await cleanup();
	}

	console.log("PASS: supplemental research e2e");
}

main().catch((error) => {
	console.error("FAIL:", error);
	void cleanup().finally(() => process.exit(1));
});
