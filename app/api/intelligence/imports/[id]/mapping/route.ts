/**
 * PATCH /api/intelligence/imports/:id/mapping — confirm which column is which.
 *
 * This is the step where a person takes responsibility for the interpretation.
 * The suggestion from upload is only a suggestion; nothing is normalised until
 * a mapping arrives here, and nothing enters the ledger until apply.
 *
 * The mapping is strict: every target field must be one we know, and every
 * source header must exist in the sheet that was actually uploaded. A mapping
 * naming a column that is not there would normalise every row to null and
 * report a clean import of nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { IMPORT_FIELDS, type ColumnMapping } from "@/lib/intelligence/imports/types";
import { validateImportRows } from "@/lib/intelligence/imports/workbook";

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mappingSchema = z
	.object(
		Object.fromEntries(IMPORT_FIELDS.map((field) => [field, z.string().min(1).max(200).optional()])),
	)
	.strict();

const bodySchema = z.object({ mapping: mappingSchema }).strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) {
		return NextResponse.json({ code: "invalid_id", message: "invalid batch id" }, { status: 404 });
	}

	let mapping: ColumnMapping;
	try {
		mapping = bodySchema.parse(await req.json()).mapping as ColumnMapping;
	} catch (error) {
		return NextResponse.json(
			{ code: "invalid_mapping", message: error instanceof Error ? error.message : "invalid mapping" },
			{ status: 400 },
		);
	}
	if (!mapping.product_name) {
		return NextResponse.json(
			{ code: "product_name_required", message: "商品名の列を指定してください" },
			{ status: 400 },
		);
	}

	const { data: batch, error: batchError } = await auth.sb
		.from("import_batches")
		.select("id, status")
		.eq("id", id)
		.eq("created_by", auth.user.id)
		.maybeSingle();
	if (batchError) {
		return NextResponse.json({ code: "read_failed", message: batchError.message }, { status: 500 });
	}
	if (!batch) return NextResponse.json({ code: "not_found", message: "not found" }, { status: 404 });
	if (batch.status === "applied" || batch.status === "partial") {
		// Remapping applied rows would leave evidence in the ledger describing a
		// mapping that no longer exists.
		return NextResponse.json(
			{ code: "already_applied", message: "適用済みの取り込みは変更できません" },
			{ status: 409 },
		);
	}

	const { data: rawRows, error: rowsError } = await auth.sb
		.from("import_rows")
		.select("row_number, raw_json")
		.eq("import_batch_id", id)
		.order("row_number", { ascending: true });
	if (rowsError) {
		return NextResponse.json({ code: "read_failed", message: rowsError.message }, { status: 500 });
	}
	const rows = rawRows ?? [];
	if (rows.length === 0) {
		return NextResponse.json({ code: "no_rows", message: "取り込む行がありません" }, { status: 409 });
	}

	// Every mapped header must exist in the stored rows. Checked against the
	// union of keys rather than the first row: a sparse sheet can leave a column
	// absent from row 2 and present everywhere else.
	const known = new Set<string>();
	for (const row of rows) for (const key of Object.keys(row.raw_json ?? {})) known.add(key);
	const missing = Object.entries(mapping)
		.filter(([, header]) => header && !known.has(header))
		.map(([field, header]) => `${field}: ${header}`);
	if (missing.length > 0) {
		return NextResponse.json(
			{ code: "unknown_header", message: `存在しない列が指定されています: ${missing.join(", ")}` },
			{ status: 400 },
		);
	}

	const normalised = validateImportRows(
		{
			sheetName: "",
			headers: [...known],
			rows: rows.map((row) => ({
				rowNumber: Number(row.row_number),
				cells: (row.raw_json ?? {}) as Record<string, unknown>,
			})),
			totalRows: rows.length,
			truncated: false,
		},
		mapping,
	);

	const service = getServiceClient();
	for (const row of normalised) {
		const { error } = await service
			.from("import_rows")
			.update({ normalized_json: row, validation_errors: row.errors })
			.eq("import_batch_id", id)
			.eq("row_number", row.rowNumber);
		if (error) {
			console.error("[imports] row normalise failed:", error.message);
			return NextResponse.json(
				{ code: "normalise_failed", message: "行の検証結果を保存できませんでした" },
				{ status: 500 },
			);
		}
	}

	const validRows = normalised.filter((row) => row.errors.length === 0).length;
	const invalidRows = normalised.length - validRows;
	// One valid row is enough to be worth applying. A batch where nothing is
	// valid is `failed`, not `validated`, so apply cannot be reached from it.
	const status = validRows > 0 ? "validated" : "failed";

	const { error: updateError } = await auth.sb
		.from("import_batches")
		.update({
			column_mapping: mapping,
			status,
			row_counts: { total: normalised.length, valid: validRows, invalid: invalidRows },
			updated_at: new Date().toISOString(),
		})
		.eq("id", id);
	if (updateError) {
		return NextResponse.json({ code: "update_failed", message: updateError.message }, { status: 500 });
	}

	return NextResponse.json({
		batchId: id,
		status,
		counts: { total: normalised.length, valid: validRows, invalid: invalidRows },
		rows: normalised.slice(0, 100),
	});
}
