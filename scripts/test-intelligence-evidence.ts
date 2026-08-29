import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildEvidenceDraft, evidenceDedupeKey } from "../lib/intelligence/evidence";
import {
	createKnowledgeSnapshot,
	upsertEvidence,
	upsertEvidenceDetailed,
} from "../lib/intelligence/repository";

async function main(): Promise<void> {
const draft = buildEvidenceDraft({
  subjectType: "product",
  subjectId: "p1",
  predicate: "airing_count_30d",
  value: 12,
  valueState: "known",
  evidenceClass: "proxy",
  sourceType: "shopch",
  sourceTable: "broadcasts",
  sourceRecordId: "slot-1",
  observedAt: "2026-08-29T00:00:00.000Z",
  confidence: 0.9,
});

assert.equal(draft.value, 12);
assert.equal(evidenceDedupeKey(draft), evidenceDedupeKey(draft));
assert.throws(() => buildEvidenceDraft({ ...draft, value: undefined, valueState: "known" }));
assert.throws(() => buildEvidenceDraft({ ...draft, value: 0, valueState: "unknown" }));

assert.equal(
	evidenceDedupeKey({
		...draft,
		value: { z: [{ b: 2, a: 1 }], a: { y: true, x: null } },
	}),
	evidenceDedupeKey({
		...draft,
		value: { a: { x: null, y: true }, z: [{ a: 1, b: 2 }] },
	}),
);

const evidenceCalls: Array<{ table: string; rows: unknown; options: unknown }> = [];
let evidenceQueries = 0;
const evidenceClient = {
	from(table: string) {
		assert.equal(table, "evidence_items");
		evidenceQueries += 1;
		if (evidenceQueries > 1) {
			return {
				select() {
					return {
						in() {
							return Promise.resolve({
								data: [{ id: "evidence-1", dedupe_key: evidenceDedupeKey(draft) }],
								error: null,
							});
						},
					};
				},
			};
		}
		return {
			upsert(rows: unknown, options: unknown) {
				evidenceCalls.push({ table, rows, options });
				return {
					select() {
						return Promise.resolve({ data: [{ id: "evidence-1", dedupe_key: evidenceDedupeKey(draft) }], error: null });
					},
				};
			},
		};
	},
} as unknown as SupabaseClient;

assert.deepEqual(await upsertEvidence(evidenceClient, [draft]), ["evidence-1"]);
assert.deepEqual(evidenceCalls[0].options, {
	onConflict: "dedupe_key",
	ignoreDuplicates: true,
});
assert.deepEqual(evidenceCalls[0].rows, [{
	subject_type: "product",
	subject_id: "p1",
	predicate: "airing_count_30d",
	value_json: 12,
	unit: null,
	value_state: "known",
	evidence_class: "proxy",
	source_type: "shopch",
	source_table: "broadcasts",
	source_record_id: "slot-1",
	source_url: null,
	source_locator: null,
	observed_at: "2026-08-29T00:00:00.000Z",
	valid_from: null,
	valid_until: null,
	confidence: 0.9,
	raw_hash: null,
	dedupe_key: evidenceDedupeKey(draft),
}]);

let duplicateEvidenceQueries = 0;
const duplicateEvidenceClient = {
	from(table: string) {
		assert.equal(table, "evidence_items");
		duplicateEvidenceQueries += 1;
		if (duplicateEvidenceQueries === 1) {
			return {
				upsert() {
					return {
						select() {
							return Promise.resolve({ data: [], error: null });
						},
					};
				},
			};
		}
		return {
			select(columns: string) {
				assert.equal(columns, "id,dedupe_key");
				return {
					in(column: string, keys: string[]) {
						assert.equal(column, "dedupe_key");
						assert.deepEqual(keys, [evidenceDedupeKey(draft)]);
						return Promise.resolve({
							data: [{ id: "existing-evidence-1", dedupe_key: evidenceDedupeKey(draft) }],
							error: null,
						});
					},
				};
			},
		};
	},
} as unknown as SupabaseClient;

assert.deepEqual(
	await upsertEvidence(duplicateEvidenceClient, [draft, draft]),
	["existing-evidence-1", "existing-evidence-1"],
);

const concurrentKey = evidenceDedupeKey({ ...draft, predicate: "concurrent_predicate" });
let concurrentQueries = 0;
const concurrentEvidenceClient = {
	from(table: string) {
		assert.equal(table, "evidence_items");
		concurrentQueries += 1;
		if (concurrentQueries === 1) {
			return {
				upsert() {
					return {
						select(columns: string) {
							assert.equal(columns, "id,dedupe_key");
							// This is the actual RETURNING payload from an ignore-duplicate
							// upsert: only the first key was durably inserted by us.
							return Promise.resolve({
								data: [{ id: "inserted-now", dedupe_key: evidenceDedupeKey(draft) }],
								error: null,
							});
						},
					};
				},
			};
		}
		return {
			select(columns: string) {
				assert.equal(columns, "id,dedupe_key");
				return {
					in(column: string, keys: string[]) {
						assert.equal(column, "dedupe_key");
						assert.deepEqual(keys.sort(), [evidenceDedupeKey(draft), concurrentKey].sort());
						return Promise.resolve({
							data: [
								{ id: "inserted-now", dedupe_key: evidenceDedupeKey(draft) },
								{ id: "won-concurrently", dedupe_key: concurrentKey },
							],
							error: null,
						});
					},
				};
			},
		};
	},
} as unknown as SupabaseClient;

const concurrentDraft = { ...draft, predicate: "concurrent_predicate" };
const detailed = await upsertEvidenceDetailed(concurrentEvidenceClient, [draft, concurrentDraft, draft]);
assert.deepEqual(detailed.ids, ["inserted-now", "won-concurrently", "inserted-now"]);
assert.deepEqual(detailed.insertedDedupeKeys, [evidenceDedupeKey(draft)]);
assert.deepEqual(
	detailed.duplicateDedupeKeys,
	[concurrentKey, evidenceDedupeKey(draft)],
	"a concurrent conflict and repeated input are both truthfully counted as duplicates",
);

const snapshotCalls: Array<{ table: string; operation: string; payload?: unknown }> = [];
const snapshotClient = {
	from(table: string) {
		if (table === "knowledge_snapshots") {
			return {
				insert(row: unknown) {
					snapshotCalls.push({ table, operation: "insert", payload: row });
					return {
						select() {
							return {
								single() {
									return Promise.resolve({ data: { id: "snapshot-1" }, error: null });
								},
							};
						},
					};
				},
			};
		}
		assert.equal(table, "knowledge_snapshot_items");
		return {
			insert(rows: unknown) {
				snapshotCalls.push({ table, operation: "insert", payload: rows });
				return Promise.resolve({ error: null });
			},
		};
	},
} as unknown as SupabaseClient;

const snapshotDraft = {
	consumerType: "research" as const,
	consumerRunId: "research-1",
	createdBy: null,
	mode: "stored_only" as const,
	query: { topic: "airing history" },
	dataCutoff: "2026-08-29T00:00:00.000Z",
	algorithmVersion: "v1",
	items: [{ evidenceItemId: "evidence-1", usageRole: "input" }],
};

assert.equal(await createKnowledgeSnapshot(snapshotClient, snapshotDraft), "snapshot-1");
assert.deepEqual(snapshotCalls, [
	{
		table: "knowledge_snapshots",
		operation: "insert",
		payload: {
			consumer_type: "research",
			consumer_run_id: "research-1",
			created_by: null,
			mode: "stored_only",
			query_json: { topic: "airing history" },
			data_cutoff: "2026-08-29T00:00:00.000Z",
			algorithm_version: "v1",
			model_version: null,
		},
	},
	{
		table: "knowledge_snapshot_items",
		operation: "insert",
		payload: [{
			knowledge_snapshot_id: "snapshot-1",
			evidence_item_id: "evidence-1",
			insight_snapshot_id: null,
			usage_role: "input",
			result_locator: null,
		}],
	},
]);

await assert.rejects(
	() => createKnowledgeSnapshot(snapshotClient, { ...snapshotDraft, items: [{ usageRole: "input" }] }),
	/exactly one source/,
);
await assert.rejects(
	() => createKnowledgeSnapshot(snapshotClient, {
		...snapshotDraft,
		items: [{ evidenceItemId: "evidence-1", insightSnapshotId: "insight-1", usageRole: "input" }],
	}),
	/exactly one source/,
);

const cleanupCalls: string[] = [];
const failingChildClient = {
	from(table: string) {
		if (table === "knowledge_snapshots") {
			return {
				insert() {
					return { select: () => ({ single: () => Promise.resolve({ data: { id: "snapshot-fail" }, error: null }) }) };
				},
				delete() {
					return { eq(_column: string, id: string) {
						cleanupCalls.push(id);
						return Promise.resolve({ error: null });
					} };
				},
			};
		}
		return { insert: () => Promise.resolve({ error: { message: "child insert failed" } }) };
	},
} as unknown as SupabaseClient;

await assert.rejects(
	() => createKnowledgeSnapshot(failingChildClient, snapshotDraft),
	/child insert failed/,
);
assert.deepEqual(cleanupCalls, ["snapshot-fail"]);

const rejectedChildCleanupCalls: string[] = [];
const rejectedChildClient = {
	from(table: string) {
		if (table === "knowledge_snapshots") {
			return {
				insert() {
					return { select: () => ({ single: () => Promise.resolve({ data: { id: "snapshot-reject" }, error: null }) }) };
				},
				delete() {
					return { eq(_column: string, id: string) {
						rejectedChildCleanupCalls.push(id);
						return Promise.resolve({ error: null });
					} };
				},
			};
		}
		return { insert: () => Promise.reject(new Error("child request threw")) };
	},
} as unknown as SupabaseClient;

await assert.rejects(
	() => createKnowledgeSnapshot(rejectedChildClient, snapshotDraft),
	/child request threw/,
);
assert.deepEqual(rejectedChildCleanupCalls, ["snapshot-reject"]);

const cleanupFailureClient = {
	from(table: string) {
		if (table === "knowledge_snapshots") {
			return {
				insert() {
					return { select: () => ({ single: () => Promise.resolve({ data: { id: "snapshot-cleanup-fail" }, error: null }) }) };
				},
				delete() {
					return { eq: () => Promise.resolve({ error: { message: "cleanup failed" } }) };
				},
			};
		}
		return { insert: () => Promise.resolve({ error: { message: "child insert failed" } }) };
	},
} as unknown as SupabaseClient;

await assert.rejects(
	() => createKnowledgeSnapshot(cleanupFailureClient, snapshotDraft),
	/cleanup failed/,
);

console.log("PASS: intelligence evidence contracts");
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
