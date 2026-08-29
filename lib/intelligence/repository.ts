import type { SupabaseClient } from "@supabase/supabase-js";

import { buildEvidenceDraft, evidenceDedupeKey } from "./evidence";
import type { EvidenceDraft, KnowledgeSnapshotDraft } from "./types";

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === "object" && error !== null && "message" in error
			? String(error.message)
			: String(error);
}

function evidenceRow(draft: EvidenceDraft) {
	const validated = buildEvidenceDraft(draft);
	return {
		subject_type: validated.subjectType,
		subject_id: validated.subjectId,
		predicate: validated.predicate,
		value_json: validated.value ?? null,
		unit: validated.unit ?? null,
		value_state: validated.valueState,
		evidence_class: validated.evidenceClass,
		source_type: validated.sourceType,
		source_table: validated.sourceTable,
		source_record_id: validated.sourceRecordId,
		source_url: validated.sourceUrl ?? null,
		source_locator: validated.sourceLocator ?? null,
		observed_at: validated.observedAt,
		valid_from: validated.validFrom ?? null,
		valid_until: validated.validUntil ?? null,
		confidence: validated.confidence,
		raw_hash: validated.rawHash ?? null,
		dedupe_key: evidenceDedupeKey(validated),
	};
}

export async function upsertEvidence(
	sb: SupabaseClient,
	drafts: EvidenceDraft[],
): Promise<string[]> {
	if (drafts.length === 0) return [];

	const rows = drafts.map(evidenceRow);
	const dedupeKeys = rows.map((row) => row.dedupe_key);
	const { error } = await sb
		.from("evidence_items")
		.upsert(rows, {
			onConflict: "dedupe_key",
			ignoreDuplicates: true,
		})
		.select("id");

	if (error) throw new Error(`upsertEvidence failed: ${error.message}`);

	const { data: resolved, error: resolveError } = await sb
		.from("evidence_items")
		.select("id,dedupe_key")
		.in("dedupe_key", [...new Set(dedupeKeys)]);
	if (resolveError) throw new Error(`upsertEvidence resolution failed: ${resolveError.message}`);

	const idsByKey = new Map((resolved ?? []).map((row) => [String(row.dedupe_key), String(row.id)]));
	return dedupeKeys.map((dedupeKey) => {
		const id = idsByKey.get(dedupeKey);
		if (!id) throw new Error(`upsertEvidence resolution missing id for dedupe key: ${dedupeKey}`);
		return id;
	});
}

function validateKnowledgeSnapshotItems(draft: KnowledgeSnapshotDraft): void {
	for (const item of draft.items) {
		const sourceCount = Number(Boolean(item.evidenceItemId)) + Number(Boolean(item.insightSnapshotId));
		if (sourceCount !== 1) {
			throw new Error("Knowledge snapshot items require exactly one source ID");
		}
	}
}

export async function createKnowledgeSnapshot(
	sb: SupabaseClient,
	draft: KnowledgeSnapshotDraft,
): Promise<string> {
	validateKnowledgeSnapshotItems(draft);

	const { data: parent, error: parentError } = await sb
		.from("knowledge_snapshots")
		.insert({
			consumer_type: draft.consumerType,
			consumer_run_id: draft.consumerRunId,
			created_by: draft.createdBy,
			mode: draft.mode,
			query_json: draft.query,
			data_cutoff: draft.dataCutoff,
			algorithm_version: draft.algorithmVersion,
			model_version: draft.modelVersion ?? null,
		})
		.select("id")
		.single();

	if (parentError) {
		throw new Error(`createKnowledgeSnapshot parent insert failed: ${parentError.message}`);
	}
	if (!parent?.id) throw new Error("createKnowledgeSnapshot parent insert returned no id");

	if (draft.items.length === 0) return String(parent.id);

	let childError: unknown;
	try {
		const { error } = await sb
			.from("knowledge_snapshot_items")
			.insert(draft.items.map((item) => ({
				knowledge_snapshot_id: parent.id,
				evidence_item_id: item.evidenceItemId ?? null,
				insight_snapshot_id: item.insightSnapshotId ?? null,
				usage_role: item.usageRole,
				result_locator: item.resultLocator ?? null,
			})));
		childError = error;
	} catch (error) {
		childError = error;
	}

	if (!childError) return String(parent.id);

	try {
		const { error: cleanupError } = await sb
			.from("knowledge_snapshots")
			.delete()
			.eq("id", parent.id);
		if (cleanupError) {
			throw new Error(`parent cleanup failed: ${cleanupError.message}`);
		}
	} catch (cleanupError) {
		throw new Error(
			`createKnowledgeSnapshot child insert failed: ${errorMessage(childError)}; ${errorMessage(cleanupError)}`,
		);
	}

	throw new Error(`createKnowledgeSnapshot child insert failed: ${errorMessage(childError)}`);
}
