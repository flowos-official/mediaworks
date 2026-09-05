import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	runProductFinderFromStoredEvidence,
	type ProductFinderItemInsert,
	type ProductFinderRepository,
} from "../lib/product-finder/run";
import type { StoredCandidate } from "../lib/product-finder/candidates";
import { parseProductFinderQuery } from "../lib/product-finder/request";

const query = parseProductFinderQuery({ category: "家電", limit: 5 });

function candidate(id: string, airings: number): StoredCandidate {
	return {
		canonicalProductId: id,
		name: `product-${id}`,
		category: "家電",
		evidenceIds: [`ev-${id}-1`, `ev-${id}-2`],
		signals: {
			tvAirings: {
				value: airings,
				evidenceClass: "proxy",
				confidence: 0.8,
				observedAt: "2026-09-01T00:00:00Z",
				evidenceItemId: `ev-${id}-1`,
			},
		},
	};
}

interface Recorded {
	runs: number;
	items: ProductFinderItemInsert[];
	completed: Array<{ runId: string; snapshotId: string }>;
	failed: Array<{ runId: string; code: string }>;
	snapshots: number;
	snapshotItems: string[];
	loads: number;
}

function fakes(over: Partial<ProductFinderRepository> = {}) {
	const rec: Recorded = {
		runs: 0,
		items: [],
		completed: [],
		failed: [],
		snapshots: 0,
		snapshotItems: [],
		loads: 0,
	};
	const repo: ProductFinderRepository = {
		async createRun() {
			rec.runs++;
			return "run-1";
		},
		async insertItems(_runId, items) {
			rec.items.push(...items);
			return items.map((_, i) => `item-${i + 1}`);
		},
		async completeRun(runId, snapshotId) {
			rec.completed.push({ runId, snapshotId });
		},
		async failRun(runId, code) {
			rec.failed.push({ runId, code });
		},
		async loadCandidates() {
			rec.loads++;
			return [candidate("a", 10), candidate("b", 2), candidate("c", 6)];
		},
		async createSnapshot(draft) {
			rec.snapshots++;
			rec.snapshotItems.push(...draft.items.map((i) => i.evidenceItemId ?? ""));
			return "snap-1";
		},
		...over,
	};
	return { rec, repo };
}

async function main() {
	// --- the happy path ---------------------------------------------------------
	{
		const { rec, repo } = fakes();
		const result = await runProductFinderFromStoredEvidence(repo, "user-1", query, { mode: "stored_only" });

		assert.equal(rec.runs, 1, "exactly one run row");
		assert.equal(rec.loads, 1, "candidates are loaded once, not per item");
		assert.equal(rec.snapshots, 1, "exactly one knowledge snapshot");
		assert.equal(rec.completed.length, 1);
		assert.deepEqual(rec.completed[0], { runId: "run-1", snapshotId: "snap-1" });
		assert.equal(rec.failed.length, 0);

		assert.equal(result.runId, "run-1");
		assert.equal(result.mode, "stored_only");
		assert.equal(result.candidateCount, 3);
		assert.equal(result.items.length, 3);
		assert.deepEqual(result.items.map((i) => i.rank), [1, 2, 3]);
		assert.deepEqual(result.query, query, "the stored query is the parsed one, verbatim");
	}
	console.log("✓ one run, one load, one snapshot, and a completed result");

	// --- the snapshot covers every displayed item -------------------------------
	// A recommendation that cannot name the evidence behind a shown row is not
	// auditable, and the CHECK on the runs table exists to make that impossible.
	{
		const { rec, repo } = fakes();
		await runProductFinderFromStoredEvidence(repo, "user-1", query, { mode: "stored_only" });
		for (const id of ["ev-a-1", "ev-a-2", "ev-b-1", "ev-b-2", "ev-c-1", "ev-c-2"]) {
			assert.ok(rec.snapshotItems.includes(id), `snapshot must record ${id}`);
		}
	}
	console.log("✓ the knowledge snapshot records the evidence behind every shown item");

	// --- limit -----------------------------------------------------------------
	{
		const { rec, repo } = fakes();
		await runProductFinderFromStoredEvidence(
			repo,
			"user-1",
			parseProductFinderQuery({ limit: 5 }),
			{ mode: "stored_only" },
		);
		assert.ok(rec.items.length <= 5);
	}
	{
		const { rec, repo } = fakes({
			async loadCandidates() {
				return Array.from({ length: 40 }, (_, i) => candidate(`p${i}`, i));
			},
		});
		const result = await runProductFinderFromStoredEvidence(
			repo,
			"user-1",
			parseProductFinderQuery({ limit: 5 }),
			{ mode: "stored_only" },
		);
		assert.equal(rec.items.length, 5, "no more than `limit` items are persisted");
		assert.equal(result.items.length, 5);
		assert.equal(result.candidateCount, 40, "the candidate count reports what was considered");
	}
	console.log("✓ only `limit` items are stored, while candidateCount reports the full pool");

	// --- failure leaves no completed run ---------------------------------------
	{
		const { rec, repo } = fakes({
			async insertItems() {
				throw new Error("insert exploded");
			},
		});
		await assert.rejects(
			() => runProductFinderFromStoredEvidence(repo, "user-1", query, { mode: "stored_only" }),
			/insert exploded/,
		);
		assert.equal(rec.completed.length, 0, "a failed run is never completed");
		assert.equal(rec.failed.length, 1);
		assert.equal(rec.failed[0]!.runId, "run-1");
	}
	console.log("✓ an item-insert failure marks the run failed and completes nothing");

	{
		const { rec, repo } = fakes({
			async createSnapshot() {
				throw new Error("snapshot exploded");
			},
		});
		await assert.rejects(
			() => runProductFinderFromStoredEvidence(repo, "user-1", query, { mode: "stored_only" }),
			/snapshot exploded/,
		);
		assert.equal(rec.completed.length, 0);
		assert.equal(rec.failed.length, 1);
	}
	console.log("✓ a snapshot failure also leaves the run incomplete");

	// --- an empty pool is a completed run with no items, not a failure ---------
	{
		const { rec, repo } = fakes({ async loadCandidates() { return []; } });
		const result = await runProductFinderFromStoredEvidence(repo, "user-1", query, { mode: "stored_only" });
		assert.equal(result.items.length, 0);
		assert.equal(rec.completed.length, 1, "holding no matching data is an answer, not an error");
		assert.equal(rec.failed.length, 0);
	}
	console.log("✓ no matching candidates completes cleanly with zero items");

	// --- deterministic prose, no model ------------------------------------------
	{
		const { repo } = fakes();
		const result = await runProductFinderFromStoredEvidence(repo, "user-1", query, { mode: "stored_only" });
		const item = result.items[0]!;
		assert.ok(Array.isArray(item.reasons) && Array.isArray(item.risks) && Array.isArray(item.missingData));
		// Profitability has no internal input in these fixtures, so it must be
		// declared missing rather than quietly omitted.
		assert.ok(
			item.missingData.some((m) => m.includes("収益性")),
			`missing data must name the unknown axes: ${JSON.stringify(item.missingData)}`,
		);
	}
	console.log("✓ reasons, risks and missing data are deterministic templates");

	// --- static no-network / no-model guard ------------------------------------
	{
		const src = readFileSync("lib/product-finder/run.ts", "utf8");
		for (const forbidden of ["@/lib/brave", "@/lib/rakuten", "@google/genai", "fetch(", "gemini"]) {
			assert.ok(!src.toLowerCase().includes(forbidden.toLowerCase()), `run.ts must not reference ${forbidden}`);
		}
	}
	console.log("✓ the run service reaches no network and no model");

	console.log("PASS: product finder run");
}

main();
