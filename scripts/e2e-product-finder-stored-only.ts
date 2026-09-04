/**
 * End-to-end gate for the stored-only contract.
 *
 * The central assertion is negative and cannot be made any other way: while a
 * recommendation runs, ANY request to a host other than Supabase throws. A
 * static import check catches the obvious regression; this catches the one that
 * arrives through a transitive dependency or a lazy import, which is exactly
 * how a "stored-only" surface would start costing money without anyone
 * noticing.
 *
 * Read-mostly: it creates one disposable run per query and deletes only what it
 * created.
 */
import assert from "node:assert/strict";
import { getServiceClient } from "@/lib/supabase";
import { parseProductFinderQuery } from "@/lib/product-finder/request";
import {
	createProductFinderRepository,
	runProductFinderFromStoredEvidence,
} from "@/lib/product-finder/run";
import type { ProductFinderResult } from "@/lib/product-finder/types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
const allowedHost = new URL(supabaseUrl).host;

let externalRequests = 0;
const realFetch = globalThis.fetch;

function installTripwire(): void {
	globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url;
		let host: string;
		try {
			host = new URL(url).host;
		} catch {
			host = "";
		}
		if (host && host !== allowedHost) {
			externalRequests++;
			throw new Error(`unexpected external request to ${host}`);
		}
		return realFetch(input, init);
	}) as typeof fetch;
}

function restoreTripwire(): void {
	globalThis.fetch = realFetch;
}

async function runOne(
	label: string,
	raw: Record<string, unknown>,
): Promise<{ result: ProductFinderResult; snapshotId: string }> {
	const sb = getServiceClient();
	const { data: profile } = await sb.from("profiles").select("id").limit(1).maybeSingle();
	if (!profile?.id) throw new Error("no profile exists to own a run");

	const query = parseProductFinderQuery(raw);
	const repo = createProductFinderRepository(sb);

	installTripwire();
	let result: ProductFinderResult;
	try {
		result = await runProductFinderFromStoredEvidence(repo, String(profile.id), query, {
			mode: "stored_only",
		});
	} finally {
		restoreTripwire();
	}

	console.log(`  [${label}] candidates=${result.candidateCount} items=${result.items.length}`);

	const { data: run, error } = await sb
		.from("product_recommendation_runs")
		.select("status, knowledge_snapshot_id, mode")
		.eq("id", result.runId)
		.single();
	if (error) throw new Error(`run read failed: ${error.message}`);
	assert.equal(run.status, "completed", `[${label}] the run must complete`);
	assert.ok(run.knowledge_snapshot_id, `[${label}] a completed run carries a snapshot`);
	assert.equal(run.mode, "stored_only");

	const { data: snapshot } = await sb
		.from("knowledge_snapshots")
		.select("mode, algorithm_version, data_cutoff")
		.eq("id", run.knowledge_snapshot_id as string)
		.single();
	assert.equal(snapshot?.mode, "stored_only", `[${label}] the snapshot records stored_only`);

	// Every displayed item must be reachable from the snapshot. A row shown
	// without a recorded basis is precisely what the CHECK and this gate exist
	// to prevent.
	const { data: snapItems } = await sb
		.from("knowledge_snapshot_items")
		.select("result_locator, evidence_item_id")
		.eq("knowledge_snapshot_id", run.knowledge_snapshot_id as string);
	const locators = new Set((snapItems ?? []).map((r) => String(r.result_locator)));
	for (const item of result.items) {
		if (item.axes.some((a) => a.status !== "unknown")) {
			assert.ok(
				locators.has(item.id),
				`[${label}] item ${item.rank} shows evidence-backed axes but is absent from the snapshot`,
			);
		}
	}

	// Ranks are dense and unique.
	const ranks = result.items.map((i) => i.rank);
	assert.equal(new Set(ranks).size, ranks.length, `[${label}] two items share a rank`);

	// Unknown profit stays null on real data.
	for (const item of result.items) {
		const profit = item.axes.find((a) => a.key === "profitability")!;
		if (profit.status === "unknown") {
			assert.equal(
				item.expectedContributionProfitJpy,
				null,
				`[${label}] an unknown profitability axis must not carry a number`,
			);
		}
	}

	return { result, snapshotId: String(run.knowledge_snapshot_id) };
}

async function cleanup(runId: string, snapshotId: string): Promise<void> {
	const sb = getServiceClient();
	await sb.from("product_recommendation_runs").delete().eq("id", runId);
	await sb.from("knowledge_snapshots").delete().eq("id", snapshotId);
}

async function main(): Promise<void> {
	const created: Array<{ runId: string; snapshotId: string }> = [];
	try {
		// An evidence-rich scope and a deliberately sparse one: the sparse case
		// is where an implementation is most tempted to invent a number.
		const rich = await runOne("all-categories", { limit: 10 });
		created.push({ runId: rich.result.runId, snapshotId: rich.snapshotId });

		const sparse = await runOne("sparse-category", {
			category: "存在しないカテゴリ",
			limit: 5,
		});
		created.push({ runId: sparse.result.runId, snapshotId: sparse.snapshotId });
		assert.equal(
			sparse.result.items.length,
			0,
			"a category we hold nothing for must return nothing, not a filled-in guess",
		);
	} finally {
		for (const { runId, snapshotId } of created) await cleanup(runId, snapshotId);
		console.log("  cleaned up");
	}

	console.log(`external_requests=${externalRequests}`);
	assert.equal(externalRequests, 0, "the stored-only path must reach no external host");
	console.log("PASS: product finder stored-only e2e");
}

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
