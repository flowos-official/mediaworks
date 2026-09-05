/**
 * End-to-end gate for Excel import, against the live database.
 *
 * The chain this proves: a spreadsheet becomes canonical products and
 * internal_input evidence, the product finder can then see internal product
 * facts, an explicit profit column is what finally makes the profitability
 * axis something other than unknown, and a rollback takes it back out of
 * FUTURE rankings while the knowledge snapshot of a past one still resolves.
 *
 * That last property is the reason rollback revokes instead of deleting, and
 * it is the hardest thing to check by reading code — hence a live gate.
 *
 * Drives the service layer directly rather than the HTTP routes: the routes
 * need a signed-in session, and their auth and staging rules are pinned
 * statically by test:intelligence-import-routes.
 *
 * Read-mostly: every row it creates is deleted or revoked at the end.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getServiceClient } from "@/lib/supabase";
import { parseWorkbook, suggestColumnMapping, validateImportRows } from "@/lib/intelligence/imports/workbook";
import {
	applyImportBatch,
	createImportApplyRepository,
	rollbackImportBatch,
} from "@/lib/intelligence/imports/apply";
import { loadStoredCandidates } from "@/lib/product-finder/candidates";
import { parseProductFinderQuery } from "@/lib/product-finder/request";
import {
	createProductFinderRepository,
	runProductFinderFromStoredEvidence,
} from "@/lib/product-finder/run";

const FIXTURES = "scripts/fixtures/intelligence-import";
const STAMP = `e2e-import-${Date.now()}`;

const created = {
	batches: [] as string[],
	canonicalProducts: [] as string[],
	recommendationRuns: [] as string[],
	snapshots: [] as string[],
};

async function stageBatch(userId: string, fixture: string): Promise<string> {
	const sb = getServiceClient();
	const parsed = parseWorkbook(new Uint8Array(readFileSync(`${FIXTURES}/${fixture}`)));
	assert.ok(parsed.rows.length > 0, `${fixture} produced no rows`);

	const { data: batch, error } = await sb
		.from("import_batches")
		.insert({
			created_by: userId,
			file_name: `${STAMP}-${fixture}`,
			storage_path: `${userId}/${STAMP}/${fixture}`,
			file_sha256: `${STAMP}-${fixture}`,
			status: "uploaded",
			row_counts: { total: parsed.totalRows },
		})
		.select("id")
		.single();
	if (error || !batch) throw new Error(`batch insert failed: ${error?.message}`);
	const batchId = String(batch.id);
	created.batches.push(batchId);

	const { error: rowsError } = await sb.from("import_rows").insert(
		parsed.rows.map((row) => ({
			import_batch_id: batchId,
			row_number: row.rowNumber,
			raw_json: row.cells,
		})),
	);
	if (rowsError) throw new Error(`row insert failed: ${rowsError.message}`);

	// Confirm the suggested mapping, exactly as the operator would.
	const mapping = suggestColumnMapping(parsed.headers);
	assert.ok(mapping.product_name, `${fixture}: product_name must be auto-detected`);
	const normalised = validateImportRows(parsed, mapping);
	for (const row of normalised) {
		await sb
			.from("import_rows")
			.update({ normalized_json: row, validation_errors: row.errors })
			.eq("import_batch_id", batchId)
			.eq("row_number", row.rowNumber);
	}
	const valid = normalised.filter((row) => row.errors.length === 0).length;
	await sb
		.from("import_batches")
		.update({
			column_mapping: mapping,
			status: valid > 0 ? "validated" : "failed",
			row_counts: { total: normalised.length, valid, invalid: normalised.length - valid },
		})
		.eq("id", batchId);
	return batchId;
}

async function candidateFor(canonicalProductId: string) {
	const sb = getServiceClient();
	// The query's `limit` bounds how many RESULTS a run shows; candidate loading
	// is bounded separately by MAX_CANDIDATES, so the smallest legal value is
	// right here — this reads the whole candidate pool either way.
	const candidates = await loadStoredCandidates(
		sb,
		parseProductFinderQuery({ limit: 5 }),
		new Date().toISOString(),
	);
	return candidates.find((candidate) => candidate.canonicalProductId === canonicalProductId);
}

async function cleanup(): Promise<void> {
	const sb = getServiceClient();
	for (const id of created.recommendationRuns) {
		await sb.from("product_recommendation_runs").delete().eq("id", id);
	}
	for (const id of created.snapshots) {
		await sb.from("knowledge_snapshots").delete().eq("id", id);
	}
	for (const batchId of created.batches) {
		// Evidence first: import_rows and the batch cascade, but evidence rows
		// hold a RESTRICT reference to the batch.
		await sb.from("evidence_items").delete().eq("import_batch_id", batchId);
		await sb.from("import_batches").delete().eq("id", batchId);
	}
	for (const id of created.canonicalProducts) {
		await sb.from("product_source_links").delete().eq("canonical_product_id", id);
		await sb.from("evidence_items").delete().eq("subject_type", "product").eq("subject_id", id);
		await sb.from("canonical_products").delete().eq("id", id);
	}
	console.log(
		`  cleaned up ${created.batches.length} batch(es) and ${created.canonicalProducts.length} product(s)`,
	);
}

async function main(): Promise<void> {
	const sb = getServiceClient();
	const { data: profile } = await sb.from("profiles").select("id").limit(1).maybeSingle();
	if (!profile?.id) throw new Error("no profile exists to own an import");
	const userId = String(profile.id);
	const repo = createImportApplyRepository(sb, sb);

	try {
		// --- product information alone is a valid import --------------------
		const minimalBatch = await stageBatch(userId, "minimal-products.xlsx");
		const minimal = await applyImportBatch(repo, minimalBatch, userId);
		assert.ok(minimal.appliedRows > 0, "a products-only sheet must apply");
		assert.ok(minimal.evidenceItems > 0);

		const { data: minimalRows } = await sb
			.from("import_rows")
			.select("canonical_product_id, normalized_json")
			.eq("import_batch_id", minimalBatch)
			.not("canonical_product_id", "is", null);
		const productIds = [...new Set((minimalRows ?? []).map((r) => String(r.canonical_product_id)))];
		created.canonicalProducts.push(...productIds);
		assert.ok(productIds.length > 0, "canonical products must exist afterwards");

		const withProductFacts = await candidateFor(productIds[0]);
		assert.ok(withProductFacts, "the product finder must see the imported product");
		assert.equal(
			withProductFacts?.signals.internalProfitJpy,
			undefined,
			"a products-only import must leave profitability unknown, not zero",
		);
		console.log(
			`  [minimal] rows=${minimal.appliedRows} evidence=${minimal.evidenceItems} products=${productIds.length} profit=unknown`,
		);

		// --- a performance sheet makes profit known -------------------------
		const performanceBatch = await stageBatch(userId, "products-with-performance.xlsx");
		const performance = await applyImportBatch(repo, performanceBatch, userId);
		assert.ok(performance.appliedRows > 0);
		// The fixture deliberately contains one unreadable row.
		assert.ok(
			performance.failedRows > 0 || performance.appliedRows < 4,
			"the deliberately broken fixture row must not apply",
		);

		const { data: perfRows } = await sb
			.from("import_rows")
			.select("canonical_product_id, normalized_json")
			.eq("import_batch_id", performanceBatch)
			.not("canonical_product_id", "is", null);
		for (const row of perfRows ?? []) {
			const id = String(row.canonical_product_id);
			if (!created.canonicalProducts.includes(id)) created.canonicalProducts.push(id);
		}

		// SKU-001 carries an explicit ZERO profit, which is a known value.
		const zeroRow = (perfRows ?? []).find(
			(row) => (row.normalized_json as { productCode?: string })?.productCode === "SKU-001",
		);
		assert.ok(zeroRow, "the zero-profit row must have applied");
		const zeroCandidate = await candidateFor(String(zeroRow?.canonical_product_id));
		assert.equal(
			zeroCandidate?.signals.internalProfitJpy?.value,
			0,
			"an explicit zero profit is a known value the finder can read",
		);
		assert.equal(zeroCandidate?.signals.internalProfitJpy?.evidenceClass, "internal_input");

		// SKU-002 left every performance cell blank: still unknown.
		const blankRow = (perfRows ?? []).find(
			(row) => (row.normalized_json as { productCode?: string })?.productCode === "SKU-002",
		);
		const blankCandidate = await candidateFor(String(blankRow?.canonical_product_id));
		assert.equal(
			blankCandidate?.signals.internalProfitJpy,
			undefined,
			"a blank profit cell must stay unknown — that is the distinction the parser exists for",
		);

		// And a real, non-zero profit reaches the ranking.
		const richRow = (perfRows ?? []).find(
			(row) => (row.normalized_json as { productCode?: string })?.productCode === "SKU-003",
		);
		const richCandidate = await candidateFor(String(richRow?.canonical_product_id));
		assert.equal(richCandidate?.signals.internalProfitJpy?.value, 5_637_500);
		console.log(
			`  [performance] rows=${performance.appliedRows} failed=${performance.failedRows}` +
				` zero-profit=0 blank-profit=unknown real-profit=${richCandidate?.signals.internalProfitJpy?.value}`,
		);

		// --- a run taken now records what it read ---------------------------
		const run = await runProductFinderFromStoredEvidence(
			createProductFinderRepository(sb),
			userId,
			parseProductFinderQuery({ limit: 30 }),
			{ mode: "stored_only" },
		);
		created.recommendationRuns.push(run.runId);
		const { data: runRow } = await sb
			.from("product_recommendation_runs")
			.select("knowledge_snapshot_id")
			.eq("id", run.runId)
			.single();
		const snapshotId = String(runRow?.knowledge_snapshot_id);
		created.snapshots.push(snapshotId);
		const { count: itemsBefore } = await sb
			.from("knowledge_snapshot_items")
			.select("id", { count: "exact", head: true })
			.eq("knowledge_snapshot_id", snapshotId);
		assert.ok((itemsBefore ?? 0) > 0, "the run must record the evidence it read");

		// --- rollback removes it from FUTURE rankings only ------------------
		const rolledBack = await rollbackImportBatch(
			repo,
			performanceBatch,
			userId,
			"E2E: 原価の列を取り違えたため取り消し",
		);
		assert.ok(rolledBack.revokedEvidence > 0, "rollback must revoke the batch's evidence");

		const afterRollback = await candidateFor(String(richRow?.canonical_product_id));
		assert.equal(
			afterRollback?.signals.internalProfitJpy,
			undefined,
			"a rolled-back profit must not rank a product any more",
		);

		// The past run still resolves. This is why rollback revokes rather than
		// deletes: a snapshot that lost its rows would silently rewrite the
		// account of a decision somebody may already have acted on.
		const { count: itemsAfter } = await sb
			.from("knowledge_snapshot_items")
			.select("id", { count: "exact", head: true })
			.eq("knowledge_snapshot_id", snapshotId);
		assert.equal(itemsAfter, itemsBefore, "a past snapshot must still name every row it read");

		const { data: revoked } = await sb
			.from("evidence_items")
			.select("id, revoked_at, revocation_reason, revoked_by")
			.eq("import_batch_id", performanceBatch)
			.limit(1);
		assert.ok(revoked?.[0]?.revoked_at, "revocation is recorded, not implied");
		assert.ok(String(revoked?.[0]?.revocation_reason).includes("E2E"));
		assert.equal(revoked?.[0]?.revoked_by, userId);

		const { data: batchAfter } = await sb
			.from("import_batches")
			.select("status")
			.eq("id", performanceBatch)
			.single();
		assert.equal(batchAfter?.status, "rolled_back");

		await rollbackImportBatch(repo, minimalBatch, userId, "E2E: 後片付け");
		console.log(
			`  [rollback] revoked=${rolledBack.revokedEvidence} future-profit=unknown past-snapshot-items=${itemsAfter}`,
		);
	} finally {
		await cleanup();
	}

	console.log("PASS: intelligence import e2e");
}

main().catch((error) => {
	console.error("FAIL:", error);
	void cleanup().finally(() => process.exit(1));
});
