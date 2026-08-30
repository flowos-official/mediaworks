/**
 * Recompute `evidence_items.dedupe_key` after the key definition changed.
 *
 * The key now includes `unit` and `evidence_class`, and normalizes
 * `observed_at` before hashing. Rows written under the old definition therefore
 * carry keys that no longer match what `evidenceDedupeKey` produces for the
 * same fact, so the next backfill would treat every one of them as new and
 * insert a duplicate — and because `selectActiveEvidence` retains every row at
 * the newest timestamp, both copies would then count.
 *
 * This reads each row, rebuilds the draft from the stored columns and rewrites
 * the key. Two old rows can now collapse onto one key — that is the point of
 * adding the fields — so the extra row is removed, oldest kept, but only when
 * nothing references it.
 *
 * Dry run by default, like the backfill. Pass --apply to write.
 *   npm run rekey:intelligence-evidence -- --apply
 */
import { getServiceClient } from "@/lib/supabase";
import { evidenceDedupeKey } from "@/lib/intelligence/evidence";
import type { EvidenceDraft } from "@/lib/intelligence/types";

const PAGE_SIZE = 500;

interface EvidenceRow {
	id: string;
	subject_type: string;
	subject_id: string;
	predicate: string;
	value_json: unknown;
	unit: string | null;
	value_state: string;
	evidence_class: string;
	source_type: string;
	source_table: string;
	source_record_id: string;
	observed_at: string;
	confidence: number;
	dedupe_key: string;
	created_at: string;
}

const COLUMNS =
	"id,subject_type,subject_id,predicate,value_json,unit,value_state,evidence_class,source_type,source_table,source_record_id,observed_at,confidence,dedupe_key,created_at";

function draftFromRow(row: EvidenceRow): EvidenceDraft {
	return {
		subjectType: row.subject_type as EvidenceDraft["subjectType"],
		subjectId: row.subject_id,
		predicate: row.predicate,
		// `value_state = 'known'` and a non-null value are enforced by a CHECK, so
		// this mirrors the stored row rather than reinterpreting it.
		...(row.value_json === null ? {} : { value: row.value_json }),
		...(row.unit === null ? {} : { unit: row.unit }),
		valueState: row.value_state as EvidenceDraft["valueState"],
		evidenceClass: row.evidence_class as EvidenceDraft["evidenceClass"],
		sourceType: row.source_type,
		sourceTable: row.source_table,
		sourceRecordId: row.source_record_id,
		observedAt: row.observed_at,
		confidence: row.confidence,
	};
}

async function main(): Promise<void> {
	const apply = process.argv.includes("--apply");
	const sb = getServiceClient();

	const rows: EvidenceRow[] = [];
	for (let offset = 0; ; offset += PAGE_SIZE) {
		const { data, error } = await sb
			.from("evidence_items")
			.select(COLUMNS)
			.order("created_at", { ascending: true })
			.order("id", { ascending: true })
			.range(offset, offset + PAGE_SIZE - 1);
		if (error) throw new Error(`evidence read failed: ${error.message}`);
		const page = (data ?? []) as unknown as EvidenceRow[];
		rows.push(...page);
		if (page.length < PAGE_SIZE) break;
	}

	const keepByKey = new Map<string, string>();
	const changes: Array<{ id: string; key: string }> = [];
	const collisions: Array<{ id: string; key: string; keptId: string }> = [];
	let unchanged = 0;

	for (const row of rows) {
		const key = evidenceDedupeKey(draftFromRow(row));
		const existing = keepByKey.get(key);
		if (existing !== undefined) {
			collisions.push({ id: row.id, key, keptId: existing });
			continue;
		}
		keepByKey.set(key, row.id);
		if (key === row.dedupe_key) unchanged += 1;
		else changes.push({ id: row.id, key });
	}

	console.log(
		JSON.stringify({
			apply,
			read: rows.length,
			unchanged,
			rekeyed: changes.length,
			collapsed: collisions.length,
		}),
	);
	if (collisions.length > 0) {
		console.log(`[rekey] ${collisions.length} row(s) now collapse onto an earlier row and will be removed`);
	}
	if (!apply) {
		console.log("[rekey] dry run — pass --apply to write");
		return;
	}

	// Remove the collapsed rows first: they hold keys the survivors are about to
	// take, and `unique (dedupe_key)` would otherwise reject the rewrite.
	for (const collision of collisions) {
		const { error } = await sb.from("evidence_items").delete().eq("id", collision.id);
		if (error) {
			// `insight_snapshot_evidence.evidence_item_id` is ON DELETE RESTRICT, so
			// a referenced row cannot be removed. Leave it and report: a stale
			// duplicate is a smaller problem than a snapshot losing its provenance.
			console.warn(`[rekey] could not remove collapsed row ${collision.id}: ${error.message}`);
		}
	}

	let written = 0;
	for (const change of changes) {
		const { error } = await sb
			.from("evidence_items")
			.update({ dedupe_key: change.key })
			.eq("id", change.id);
		if (error) throw new Error(`rekey failed for ${change.id}: ${error.message}`);
		written += 1;
	}
	console.log(JSON.stringify({ applied: true, written, collapsed: collisions.length }));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
