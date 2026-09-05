/**
 * Writing a spreadsheet into the ledger, and taking it back.
 *
 * The two failures worth building against:
 *
 *   Merging two real products because their names normalise alike. Every later
 *   fact about either would attach to a product that is half of each, and
 *   nothing downstream could detect it — so an ambiguous row fails for review
 *   rather than picking one.
 *
 *   A rollback that deletes. A knowledge snapshot taken while the evidence was
 *   active still names those rows; deleting them would break that link and
 *   silently rewrite what a past recommendation is recorded as having read.
 */
import assert from "node:assert/strict";
import {
	applyImportBatch,
	importRowEvidence,
	ImportApplyError,
	NAME_MATCH_CONFIDENCE,
	normaliseProductKey,
	rollbackImportBatch,
	type ImportApplyRepository,
} from "../lib/intelligence/imports/apply";
import type { NormalizedImportRow } from "../lib/intelligence/imports/types";

const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT = "2026-09-05T00:00:00.000Z";

function row(over: Partial<NormalizedImportRow> = {}): NormalizedImportRow {
	return {
		rowNumber: 2,
		productName: "静音ブレンダー Pro",
		productCode: "SKU-001",
		brand: null,
		modelName: null,
		category: "家電",
		description: null,
		metrics: {},
		periodStart: null,
		periodEnd: null,
		errors: [],
		...over,
	};
}

interface Calls {
	created: string[];
	linked: Array<{ sourceRecordId: string; matchMethod: string; confidence: number }>;
	evidence: number;
	applied: number[];
	failed: Array<{ rowNumber: number; errors: string[] }>;
	statuses: Array<{ status: string; counts: Record<string, number> }>;
	revoked: number;
	markedOrphans: number;
}

function harness(over: Partial<ImportApplyRepository> = {}, rows: NormalizedImportRow[] = [row()]): {
	repo: ImportApplyRepository;
	calls: Calls;
} {
	const calls: Calls = {
		created: [], linked: [], evidence: 0, applied: [], failed: [],
		statuses: [], revoked: 0, markedOrphans: 0,
	};
	const repo: ImportApplyRepository = {
		async loadBatch(batchId, userId) {
			return batchId === BATCH && userId === USER ? { id: BATCH, status: "validated" } : null;
		},
		async loadValidRows() {
			return rows;
		},
		async findLinkByCode() {
			return null;
		},
		async findByNormalisedName() {
			return [];
		},
		async createCanonicalProduct(input) {
			calls.created.push(input.displayName);
			return `cp-${calls.created.length}`;
		},
		async linkSource(input) {
			calls.linked.push({
				sourceRecordId: input.sourceRecordId,
				matchMethod: input.matchMethod,
				confidence: input.confidence,
			});
		},
		async insertEvidence(drafts) {
			calls.evidence += drafts.length;
			return drafts.length;
		},
		async markRowApplied(_b, rowNumber) {
			calls.applied.push(rowNumber);
		},
		async markRowFailed(_b, rowNumber, errors) {
			calls.failed.push({ rowNumber, errors });
		},
		async setBatchStatus(_b, status, counts) {
			calls.statuses.push({ status, counts });
		},
		async revokeBatchEvidence() {
			calls.revoked = 7;
			return 7;
		},
		async markOrphanedLinks() {
			calls.markedOrphans = 1;
			return 1;
		},
		...over,
	};
	return { repo, calls };
}

async function main(): Promise<void> {
	// --- a new product is created and linked --------------------------------
	{
		const { repo, calls } = harness();
		const result = await applyImportBatch(repo, BATCH, USER, AT);
		assert.equal(result.appliedRows, 1);
		assert.equal(result.failedRows, 0);
		assert.deepEqual(calls.created, ["静音ブレンダー Pro"]);
		assert.equal(calls.linked[0].sourceRecordId, "SKU-001", "the product code is the link key");
		assert.equal(calls.statuses[0].status, "applied");
	}
	console.log("✓ a new product is created, linked and applied");

	// --- an existing code reuses its product, without creating one ----------
	{
		const { repo, calls } = harness({ async findLinkByCode() { return "cp-existing"; } });
		await applyImportBatch(repo, BATCH, USER, AT);
		assert.deepEqual(calls.created, [], "a known product code must not mint a second product");
		assert.equal(calls.linked[0].matchMethod, "exact_id");
		assert.equal(calls.linked[0].confidence, 1);
	}
	console.log("✓ a known product code reuses its canonical product");

	// --- an ambiguous name fails for review ---------------------------------
	// This is the case that would corrupt the ledger invisibly.
	{
		const { repo, calls } = harness(
			{ async findByNormalisedName() { return ["cp-a", "cp-b"]; } },
			[row({ productCode: null })],
		);
		const result = await applyImportBatch(repo, BATCH, USER, AT);
		assert.equal(result.appliedRows, 0);
		assert.equal(result.failedRows, 1);
		assert.deepEqual(calls.created, [], "an ambiguous row must not create a third product either");
		assert.equal(calls.evidence, 0, "and must write no evidence");
		assert.ok(calls.failed[0].errors[0].includes("2件"), "the operator is told how many matched");
		assert.equal(calls.statuses[0].status, "failed");
	}
	console.log("✓ two products with the same normalised name fail the row instead of merging");

	// --- a unique name match reuses that product ----------------------------
	{
		const { repo, calls } = harness(
			{ async findByNormalisedName() { return ["cp-unique"]; } },
			[row({ productCode: null })],
		);
		await applyImportBatch(repo, BATCH, USER, AT);
		assert.deepEqual(calls.created, []);
		assert.equal(calls.linked[0].matchMethod, "normalized_key");
		assert.equal(calls.linked[0].confidence, NAME_MATCH_CONFIDENCE);
	}
	console.log("✓ a unique name match reuses the product, at a stated confidence");

	// --- partial is its own state -------------------------------------------
	{
		const { repo, calls } = harness(
			{
				async findByNormalisedName(key) {
					return key.includes("あいまい") ? ["a", "b"] : [];
				},
			},
			[row({ rowNumber: 2 }), row({ rowNumber: 3, productCode: null, productName: "あいまい商品" })],
		);
		const result = await applyImportBatch(repo, BATCH, USER, AT);
		assert.equal(result.appliedRows, 1);
		assert.equal(result.failedRows, 1);
		assert.equal(
			calls.statuses[0].status,
			"partial",
			"half a batch is not a success — the operator must see that without counting",
		);
	}
	console.log("✓ a half-applied batch is partial, not applied");

	// --- an unvalidated batch cannot be applied -----------------------------
	{
		const { repo } = harness({ async loadBatch() { return { id: BATCH, status: "uploaded" }; } });
		await assert.rejects(
			applyImportBatch(repo, BATCH, USER, AT),
			(e: unknown) => e instanceof ImportApplyError && e.code === "not_validated",
			"applying before a mapping is confirmed would write whatever the raw cells held",
		);
	}
	{
		const { repo } = harness();
		await assert.rejects(
			applyImportBatch(repo, BATCH, "someone-else", AT),
			(e: unknown) => e instanceof ImportApplyError && e.code === "batch_not_found",
		);
	}
	console.log("✓ apply requires a validated batch and its owner");

	// --- blank, zero and unmapped produce three different results -----------
	{
		const zero = importRowEvidence(
			row({ metrics: { quantity: 0, revenue_jpy: 0, gross_profit_jpy: 0 } }),
			"cp-1",
			BATCH,
			AT,
		);
		const zeroPredicates = zero.map((d) => d.predicate);
		assert.ok(zeroPredicates.includes("units_sold"), "an explicit zero IS a fact and must be stored");
		assert.equal(zero.find((d) => d.predicate === "units_sold")?.value, 0);
		assert.equal(zero.find((d) => d.predicate === "gross_profit_jpy")?.value, 0);

		const blank = importRowEvidence(
			row({ metrics: { quantity: null, revenue_jpy: null } }),
			"cp-1",
			BATCH,
			AT,
		);
		assert.equal(
			blank.some((d) => d.predicate === "units_sold"),
			false,
			"a blank cell must produce no evidence row at all",
		);

		const unmapped = importRowEvidence(row(), "cp-1", BATCH, AT);
		assert.equal(unmapped.some((d) => d.predicate === "units_sold"), false);
		// Product fields still land: product information alone is a valid import.
		assert.ok(unmapped.some((d) => d.predicate === "name"));
		assert.ok(unmapped.some((d) => d.predicate === "normalized_category"));
		for (const draft of unmapped) {
			assert.equal(draft.evidenceClass, "internal_input", "our own spreadsheet is our own input");
			assert.equal(draft.sourceType, "internal_excel");
			assert.equal(draft.valueState, "known");
		}
	}
	console.log("✓ zero is stored, blank writes nothing, and an unmapped column writes nothing");

	// --- a period becomes the evidence's validity window --------------------
	{
		const drafts = importRowEvidence(
			row({ metrics: { revenue_jpy: 1000 }, periodStart: "2026-08-01", periodEnd: "2026-08-31" }),
			"cp-1",
			BATCH,
			AT,
		);
		const revenue = drafts.find((d) => d.predicate === "revenue_jpy")!;
		assert.equal(revenue.validFrom, "2026-08-01");
		assert.equal(revenue.validUntil, "2026-08-31");
		assert.equal(revenue.unit, "JPY");
		// A product NAME has no sales period, so it must not inherit one.
		assert.equal(drafts.find((d) => d.predicate === "name")?.validFrom, undefined);
	}
	console.log("✓ a reporting period bounds the metric evidence, not the product facts");

	// --- rollback revokes, and demands a reason -----------------------------
	{
		const { repo, calls } = harness({ async loadBatch() { return { id: BATCH, status: "applied" }; } });
		const result = await rollbackImportBatch(repo, BATCH, USER, "原価の列を取り違えたため");
		assert.equal(result.revokedEvidence, 7);
		assert.equal(calls.markedOrphans, 1, "orphaned links are marked, never deleted");
		assert.equal(calls.statuses[0].status, "rolled_back");

		for (const reason of ["", "  ", "x", "あ".repeat(501)]) {
			await assert.rejects(
				rollbackImportBatch(repo, BATCH, USER, reason),
				(e: unknown) => e instanceof ImportApplyError && e.code === "reason_required",
				`"${reason.slice(0, 8)}" must not be an acceptable reason`,
			);
		}
	}
	{
		const { repo } = harness({ async loadBatch() { return { id: BATCH, status: "validated" }; } });
		await assert.rejects(
			rollbackImportBatch(repo, BATCH, USER, "まだ適用していない"),
			(e: unknown) => e instanceof ImportApplyError && e.code === "not_applied",
		);
	}
	console.log("✓ rollback revokes with a required reason and only from an applied batch");

	// --- rollback never deletes ---------------------------------------------
	{
		const { readFileSync } = await import("node:fs");
		const source = readFileSync("lib/intelligence/imports/apply.ts", "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		assert.equal(
			/\.delete\(\)/.test(source),
			false,
			"nothing in apply or rollback may delete — a past snapshot still names these rows",
		);
		assert.ok(source.includes("revoked_at"), "rollback sets the revocation fields");
		assert.ok(source.includes("revocation_reason"));
	}
	console.log("✓ nothing in the apply path deletes anything");

	// --- normalisation is for proposing, not deciding -----------------------
	{
		assert.equal(normaliseProductKey("静音ブレンダー Pro"), normaliseProductKey("静音ブレンダーPRO"));
		assert.equal(normaliseProductKey("A-100 (黒)"), normaliseProductKey("a100黒"));
		assert.notEqual(normaliseProductKey("ブレンダー"), normaliseProductKey("ミキサー"));
	}
	console.log("✓ name normalisation collapses formatting, not meaning");

	console.log("PASS: intelligence import apply");
}

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
