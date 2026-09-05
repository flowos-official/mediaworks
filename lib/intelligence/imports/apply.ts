/**
 * Turn a validated spreadsheet into canonical products and internal evidence,
 * and be able to take it back.
 *
 * Two rules shape everything here.
 *
 *   Matching is conservative. An exact product code that already has a source
 *   link wins; a normalised name match is accepted only when it is UNIQUE, and
 *   an ambiguous row is left failed for a person to look at. Merging two real
 *   products because their names normalise alike would corrupt the ledger in a
 *   way nothing downstream could detect — every later fact about either one
 *   would attach to a product that is half of each.
 *
 *   Rollback REVOKES, it does not delete. A knowledge snapshot taken while the
 *   evidence was active still names those rows, and deleting them would break
 *   that link and quietly rewrite what a past recommendation read. Canonical
 *   products and source links survive too: something else may already depend on
 *   them, and an unconfirmed link with no active evidence left is marked for
 *   later cleanup rather than removed underneath it.
 *
 * A blank metric produces NO evidence row. An explicit 0 produces a row whose
 * value is 0. That distinction is carried the whole way from the cell.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildEvidenceDraft } from "@/lib/intelligence/evidence";
import type { EvidenceDraft } from "@/lib/intelligence/types";
import { METRIC_FIELDS, type MetricField, type NormalizedImportRow } from "./types";

export interface ApplyResult {
	appliedRows: number;
	failedRows: number;
	evidenceItems: number;
}

export interface RollbackResult {
	revokedEvidence: number;
}

/** Metric column → ledger predicate. `gross_profit_jpy` is the one the product
 *  finder's profitability axis reads, which is why an import is what finally
 *  makes that axis anything other than unknown. */
const METRIC_PREDICATES: Record<MetricField, string> = {
	list_price_jpy: "list_price_jpy",
	sale_price_jpy: "price_jpy",
	quantity: "units_sold",
	revenue_jpy: "revenue_jpy",
	cost_jpy: "cost_jpy",
	fees_jpy: "fees_jpy",
	shipping_jpy: "shipping_jpy",
	gross_profit_jpy: "gross_profit_jpy",
};

const METRIC_UNITS: Partial<Record<MetricField, string>> = {
	list_price_jpy: "JPY",
	sale_price_jpy: "JPY",
	revenue_jpy: "JPY",
	cost_jpy: "JPY",
	fees_jpy: "JPY",
	shipping_jpy: "JPY",
	gross_profit_jpy: "JPY",
};

/** Product-descriptive fields. These are our own input about our own product,
 *  so they are `internal_input` and may be stated directly. */
const TEXT_FIELDS: Array<[keyof NormalizedImportRow, string]> = [
	["productName", "name"],
	["brand", "brand"],
	["modelName", "model_name"],
	["category", "normalized_category"],
	["description", "description"],
];

/** Case, width, spacing and punctuation removed. Used ONLY to propose a match,
 *  never to decide one on its own. */
export function normaliseProductKey(name: string): string {
	return name
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s　]/g, "")
		.replace(/[()（）[\]【】/\\・,，.。\-_'"]/g, "")
		.trim();
}

export function importRowEvidence(
	row: NormalizedImportRow,
	canonicalProductId: string,
	batchId: string,
	observedAt: string,
): EvidenceDraft[] {
	const drafts: EvidenceDraft[] = [];
	const base = {
		subjectType: "product" as const,
		subjectId: canonicalProductId,
		valueState: "known" as const,
		evidenceClass: "internal_input" as const,
		sourceType: "internal_excel",
		sourceTable: "import_rows",
		// Batch + row: re-applying a corrected batch produces new rows rather
		// than colliding with the old ones, and the old ones stay revocable.
		sourceRecordId: `${batchId}:${row.rowNumber}`,
		observedAt,
		confidence: 1,
	};

	for (const [field, predicate] of TEXT_FIELDS) {
		const value = row[field];
		if (typeof value !== "string" || value.trim() === "") continue;
		drafts.push(buildEvidenceDraft({ ...base, predicate, value: value.trim() }));
	}

	for (const field of METRIC_FIELDS) {
		const value = row.metrics[field];
		// `undefined` means the column was never mapped; `null` means the cell was
		// blank. Neither is a fact. `0` is.
		if (value === undefined || value === null) continue;
		drafts.push(
			buildEvidenceDraft({
				...base,
				predicate: METRIC_PREDICATES[field],
				value,
				...(METRIC_UNITS[field] ? { unit: METRIC_UNITS[field] } : {}),
				...(row.periodStart ? { validFrom: row.periodStart } : {}),
				...(row.periodEnd ? { validUntil: row.periodEnd } : {}),
			}),
		);
	}

	return drafts;
}

export interface ImportApplyRepository {
	loadBatch(batchId: string, userId: string): Promise<{ id: string; status: string } | null>;
	loadValidRows(batchId: string): Promise<NormalizedImportRow[]>;
	/** An existing link for this exact product code, if we have seen it before. */
	findLinkByCode(sourceRecordId: string): Promise<string | null>;
	/** Active canonical products whose normalised name matches. More than one
	 *  means ambiguous, and ambiguous means a person looks at it. */
	findByNormalisedName(key: string): Promise<string[]>;
	createCanonicalProduct(input: {
		displayName: string;
		brand: string | null;
		modelName: string | null;
		category: string | null;
	}): Promise<string>;
	linkSource(input: {
		canonicalProductId: string;
		sourceRecordId: string;
		rawName: string;
		matchMethod: "exact_id" | "normalized_key" | "similarity" | "manual";
		confidence: number;
	}): Promise<void>;
	insertEvidence(drafts: EvidenceDraft[], batchId: string): Promise<number>;
	markRowApplied(batchId: string, rowNumber: number, canonicalProductId: string): Promise<void>;
	markRowFailed(batchId: string, rowNumber: number, errors: string[]): Promise<void>;
	setBatchStatus(batchId: string, status: string, counts: Record<string, number>): Promise<void>;
	/** Rollback side. */
	revokeBatchEvidence(batchId: string, userId: string, reason: string): Promise<number>;
	markOrphanedLinks(batchId: string): Promise<number>;
}

/** A name match is only accepted at or above this. Below it, or when more than
 *  one product matches, the row is failed for review. */
export const NAME_MATCH_CONFIDENCE = 0.95;

export async function applyImportBatch(
	repo: ImportApplyRepository,
	batchId: string,
	userId: string,
	observedAt: string = new Date().toISOString(),
): Promise<ApplyResult> {
	const batch = await repo.loadBatch(batchId, userId);
	if (!batch) throw new ImportApplyError("batch_not_found", "not found", 404);
	if (batch.status !== "validated") {
		// Applying an unvalidated batch would write whatever the raw cells held.
		throw new ImportApplyError(
			"not_validated",
			"列マッピングを確定してから適用してください",
			409,
		);
	}

	const rows = await repo.loadValidRows(batchId);
	let appliedRows = 0;
	let failedRows = 0;
	let evidenceItems = 0;

	for (const row of rows) {
		try {
			const code = row.productCode?.trim();
			let canonicalProductId: string | null = null;
			let matchMethod: "exact_id" | "normalized_key" = "normalized_key";
			let confidence = NAME_MATCH_CONFIDENCE;

			if (code) {
				canonicalProductId = await repo.findLinkByCode(code);
				if (canonicalProductId) {
					matchMethod = "exact_id";
					confidence = 1;
				}
			}

			if (!canonicalProductId) {
				const matches = await repo.findByNormalisedName(normaliseProductKey(row.productName));
				if (matches.length > 1) {
					// Two real products whose names normalise alike. Choosing one
					// would attach every later fact about either to a product that is
					// half of each, and nothing downstream could detect it.
					failedRows++;
					await repo.markRowFailed(batchId, row.rowNumber, [
						`同名の商品が${matches.length}件あり、自動で特定できません`,
					]);
					continue;
				}
				if (matches.length === 1) {
					canonicalProductId = matches[0];
				} else {
					canonicalProductId = await repo.createCanonicalProduct({
						displayName: row.productName,
						brand: row.brand,
						modelName: row.modelName,
						category: row.category,
					});
					matchMethod = "exact_id";
					confidence = 1;
				}
			}

			await repo.linkSource({
				canonicalProductId,
				sourceRecordId: code || `${batchId}:${row.rowNumber}`,
				rawName: row.productName,
				matchMethod,
				confidence,
			});

			const drafts = importRowEvidence(row, canonicalProductId, batchId, observedAt);
			evidenceItems += await repo.insertEvidence(drafts, batchId);
			await repo.markRowApplied(batchId, row.rowNumber, canonicalProductId);
			appliedRows++;
		} catch (error) {
			failedRows++;
			await repo.markRowFailed(batchId, row.rowNumber, [
				error instanceof Error ? error.message.slice(0, 200) : "適用に失敗しました",
			]);
		}
	}

	// `partial` is its own state. A batch where half the rows failed is not a
	// success, and the operator has to be able to see that without counting.
	const status = failedRows === 0 && appliedRows > 0 ? "applied" : appliedRows > 0 ? "partial" : "failed";
	await repo.setBatchStatus(batchId, status, { applied: appliedRows, failed: failedRows, evidence: evidenceItems });

	return { appliedRows, failedRows, evidenceItems };
}

export async function rollbackImportBatch(
	repo: ImportApplyRepository,
	batchId: string,
	userId: string,
	reason: string,
): Promise<RollbackResult> {
	const trimmed = reason.trim();
	if (trimmed.length < 3 || trimmed.length > 500) {
		// A rollback with no reason is unreviewable six weeks later, which is
		// exactly when somebody asks why a number changed.
		throw new ImportApplyError("reason_required", "取り消し理由を3〜500文字で入力してください", 400);
	}
	const batch = await repo.loadBatch(batchId, userId);
	if (!batch) throw new ImportApplyError("batch_not_found", "not found", 404);
	if (batch.status !== "applied" && batch.status !== "partial") {
		throw new ImportApplyError("not_applied", "適用済みの取り込みのみ取り消せます", 409);
	}

	const revokedEvidence = await repo.revokeBatchEvidence(batchId, userId, trimmed);
	// Links are marked, not deleted: something else may already depend on the
	// canonical product, and removing it underneath would break those rows.
	await repo.markOrphanedLinks(batchId);
	await repo.setBatchStatus(batchId, "rolled_back", { revoked: revokedEvidence });
	return { revokedEvidence };
}

export class ImportApplyError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "ImportApplyError";
		this.code = code;
		this.status = status;
	}
}

/** The live repository. Every write here needs the service client: canonical
 *  products, source links and evidence are all service-role-write by design
 *  (20260830100000), and the batch rows are owner-scoped by RLS. */
export function createImportApplyRepository(
	sb: SupabaseClient,
	service: SupabaseClient,
): ImportApplyRepository {
	return {
		async loadBatch(batchId, userId) {
			const { data, error } = await sb
				.from("import_batches")
				.select("id, status")
				.eq("id", batchId)
				.eq("created_by", userId)
				.maybeSingle();
			if (error) throw new Error(`batch lookup failed: ${error.message}`);
			return data ? { id: String(data.id), status: String(data.status) } : null;
		},
		async loadValidRows(batchId) {
			const { data, error } = await sb
				.from("import_rows")
				.select("row_number, normalized_json, validation_errors")
				.eq("import_batch_id", batchId)
				.order("row_number", { ascending: true });
			if (error) throw new Error(`row load failed: ${error.message}`);
			return (data ?? [])
				.filter((row) => Array.isArray(row.validation_errors) && row.validation_errors.length === 0)
				.map((row) => row.normalized_json as NormalizedImportRow)
				.filter((row): row is NormalizedImportRow => Boolean(row?.productName));
		},
		async findLinkByCode(sourceRecordId) {
			const { data, error } = await service
				.from("product_source_links")
				.select("canonical_product_id")
				.eq("source_type", "internal_excel")
				.eq("source_table", "import_rows")
				.eq("source_record_id", sourceRecordId)
				.maybeSingle();
			if (error) throw new Error(`link lookup failed: ${error.message}`);
			return data ? String(data.canonical_product_id) : null;
		},
		async findByNormalisedName(key) {
			// Normalisation happens in memory: the database holds display names as
			// typed, and a SQL-side normalisation would need an index we do not
			// have. Bounded so a pathological key cannot scan the table.
			const { data, error } = await service
				.from("canonical_products")
				.select("id, display_name")
				.eq("status", "active")
				.limit(2000);
			if (error) throw new Error(`canonical lookup failed: ${error.message}`);
			return (data ?? [])
				.filter((row) => normaliseProductKey(String(row.display_name)) === key)
				.map((row) => String(row.id));
		},
		async createCanonicalProduct(input) {
			const { data, error } = await service
				.from("canonical_products")
				.insert({
					display_name: input.displayName,
					brand: input.brand,
					model_name: input.modelName,
					normalized_category: input.category,
					status: "active",
				})
				.select("id")
				.single();
			if (error) throw new Error(`canonical product insert failed: ${error.message}`);
			return String(data.id);
		},
		async linkSource(input) {
			const { error } = await service.from("product_source_links").upsert(
				{
					canonical_product_id: input.canonicalProductId,
					source_type: "internal_excel",
					source_table: "import_rows",
					source_record_id: input.sourceRecordId,
					raw_name: input.rawName,
					match_method: input.matchMethod,
					confidence: input.confidence,
				},
				{ onConflict: "source_type,source_table,source_record_id" },
			);
			if (error) throw new Error(`source link failed: ${error.message}`);
		},
		async insertEvidence(drafts, batchId) {
			if (drafts.length === 0) return 0;
			const { upsertEvidence } = await import("@/lib/intelligence/repository");
			const ids = await upsertEvidence(service, drafts);
			// Stamped after insert so a rollback can find every row this batch
			// produced, including ones that deduped onto an existing key.
			const { error } = await service
				.from("evidence_items")
				.update({ import_batch_id: batchId })
				.in("id", ids)
				.is("import_batch_id", null);
			if (error) throw new Error(`evidence batch stamp failed: ${error.message}`);
			return ids.length;
		},
		async markRowApplied(batchId, rowNumber, canonicalProductId) {
			await service
				.from("import_rows")
				.update({ canonical_product_id: canonicalProductId, applied_at: new Date().toISOString() })
				.eq("import_batch_id", batchId)
				.eq("row_number", rowNumber);
		},
		async markRowFailed(batchId, rowNumber, errors) {
			await service
				.from("import_rows")
				.update({ validation_errors: errors })
				.eq("import_batch_id", batchId)
				.eq("row_number", rowNumber);
		},
		async setBatchStatus(batchId, status, counts) {
			const { error } = await sb
				.from("import_batches")
				.update({ status, row_counts: counts, updated_at: new Date().toISOString() })
				.eq("id", batchId);
			if (error) throw new Error(`batch status update failed: ${error.message}`);
		},
		async revokeBatchEvidence(batchId, userId, reason) {
			const { data, error } = await service
				.from("evidence_items")
				.update({
					revoked_at: new Date().toISOString(),
					revoked_by: userId,
					revocation_reason: reason,
				})
				.eq("import_batch_id", batchId)
				.is("revoked_at", null)
				.select("id");
			if (error) throw new Error(`evidence revocation failed: ${error.message}`);
			return (data ?? []).length;
		},
		async markOrphanedLinks(batchId) {
			// Only links this batch created, only unconfirmed ones, and only when
			// no active evidence is left for that product. Anything else may be
			// carrying facts from another source.
			const { data: rows } = await service
				.from("import_rows")
				.select("canonical_product_id")
				.eq("import_batch_id", batchId)
				.not("canonical_product_id", "is", null);
			const productIds = [...new Set((rows ?? []).map((r) => String(r.canonical_product_id)))];
			let marked = 0;
			for (const productId of productIds) {
				const { count } = await service
					.from("evidence_items")
					.select("id", { count: "exact", head: true })
					.eq("subject_type", "product")
					.eq("subject_id", productId)
					.is("revoked_at", null);
				if ((count ?? 0) > 0) continue;
				const { error } = await service
					.from("product_source_links")
					.update({ match_method: "manual", confidence: 0 })
					.eq("canonical_product_id", productId)
					.eq("source_type", "internal_excel")
					.eq("confirmed", false);
				if (!error) marked++;
			}
			return marked;
		},
	};
}
