/**
 * POST /api/intelligence/imports — upload one spreadsheet and preview it.
 *
 * The file is an operator's own cost book, so it goes to a private bucket
 * under their own uid prefix and is never made public. What comes back is a
 * preview and a SUGGESTED mapping, not an applied one: nothing enters the
 * evidence ledger until a person has confirmed which column is which.
 *
 * A duplicate file hash creates a NEW batch and returns a warning naming the
 * earlier ones. Silently reusing the previous batch would hide a re-upload
 * after a correction; rejecting it outright would block the legitimate case of
 * re-importing the same month deliberately. The operator decides.
 */
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { checkMagicBytes } from "@/lib/upload/magic-bytes";
import { parseWorkbook, suggestColumnMapping } from "@/lib/intelligence/imports/workbook";

export const maxDuration = 60;

const MAX_BYTES = 15 * 1024 * 1024;
const SAMPLE_ROWS = 20;
const BUCKET = "intelligence-imports";

const EXCEL_MIMES = new Set([
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const EXT_TO_MIME: Record<string, string> = {
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Path segments come from a filename the operator chose. Anything that could
 *  climb out of their own folder is removed rather than escaped. */
function safeFileName(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? "upload.xlsx";
	const cleaned = base.replace(/[^\w.\-一-龯ぁ-んァ-ヶ가-힣]/g, "_").replace(/\.{2,}/g, ".");
	return (cleaned || "upload.xlsx").slice(0, 120);
}

export async function GET() {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { data, error } = await auth.sb
		.from("import_batches")
		.select("id, file_name, file_sha256, status, row_counts, created_at, updated_at")
		.order("created_at", { ascending: false })
		.limit(50);
	if (error) return NextResponse.json({ code: "read_failed", message: error.message }, { status: 500 });
	return NextResponse.json({ batches: data ?? [] });
}

export async function POST(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const form = await req.formData().catch(() => null);
	if (!form) {
		return NextResponse.json({ code: "invalid_body", message: "multipart body required" }, { status: 400 });
	}
	const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
	if (files.length !== 1) {
		// One file per batch: a batch is the unit of apply and rollback, and two
		// files in one would make "roll this back" ambiguous.
		return NextResponse.json(
			{ code: "one_file", message: "1ファイルのみアップロードできます" },
			{ status: 400 },
		);
	}
	const file = files[0];
	if (file.size > MAX_BYTES) {
		return NextResponse.json(
			{ code: "too_large", message: "ファイルは15MB以下にしてください" },
			{ status: 413 },
		);
	}

	const declaredMime =
		file.type && EXCEL_MIMES.has(file.type)
			? file.type
			: EXT_TO_MIME[file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ""];
	if (!declaredMime) {
		return NextResponse.json(
			{ code: "unsupported_type", message: "Excel (.xls / .xlsx) のみ取り込めます" },
			{ status: 415 },
		);
	}

	const bytes = Buffer.from(await file.arrayBuffer());
	// The declared type is a claim by the browser. An .xlsx is a zip, and so is
	// a great many other things.
	const magic = checkMagicBytes(bytes, declaredMime);
	if (magic.kind !== "match") {
		return NextResponse.json(
			{ code: "content_mismatch", message: "ファイルの内容が拡張子と一致しません" },
			{ status: 415 },
		);
	}

	const parsed = parseWorkbook(new Uint8Array(bytes));
	if (parsed.headers.length === 0 || parsed.rows.length === 0) {
		return NextResponse.json(
			{ code: "empty_workbook", message: "読み取れる表が見つかりませんでした" },
			{ status: 422 },
		);
	}

	const fileSha256 = createHash("sha256").update(bytes).digest("hex");
	const { data: duplicates } = await auth.sb
		.from("import_batches")
		.select("id, created_at, status")
		.eq("file_sha256", fileSha256)
		.order("created_at", { ascending: false })
		.limit(5);

	const service = getServiceClient();
	const { data: batch, error: batchError } = await auth.sb
		.from("import_batches")
		.insert({
			created_by: auth.user.id,
			file_name: file.name.slice(0, 200),
			// Filled in below; the batch id is part of the path, so the row has to
			// exist first.
			storage_path: "",
			file_sha256: fileSha256,
			status: "uploaded",
			row_counts: { total: parsed.totalRows, previewed: parsed.rows.length },
		})
		.select("id")
		.single();
	if (batchError || !batch) {
		console.error("[imports] batch insert failed:", batchError);
		return NextResponse.json({ code: "batch_failed", message: "取り込みを開始できませんでした" }, { status: 500 });
	}
	const batchId = String(batch.id);
	const storagePath = `${auth.user.id}/${batchId}/${safeFileName(file.name)}`;

	// Service credentials: the bucket grants no INSERT to authenticated, because
	// a client that could write directly could choose a path under someone
	// else's prefix.
	const upload = await service.storage.from(BUCKET).upload(storagePath, bytes, {
		contentType: declaredMime,
		upsert: false,
	});
	if (upload.error) {
		console.error("[imports] storage upload failed:", upload.error.message);
		await auth.sb.from("import_batches").update({ status: "failed" }).eq("id", batchId);
		return NextResponse.json({ code: "upload_failed", message: "ファイルを保存できませんでした" }, { status: 500 });
	}

	// Raw rows are persisted BEFORE the preview is returned, so the mapping step
	// works from what was stored rather than from what the client still holds.
	const { error: rowsError } = await service.from("import_rows").insert(
		parsed.rows.map((row) => ({
			import_batch_id: batchId,
			row_number: row.rowNumber,
			raw_json: row.cells,
		})),
	);
	if (rowsError) {
		console.error("[imports] row insert failed:", rowsError.message);
		await auth.sb.from("import_batches").update({ status: "failed" }).eq("id", batchId);
		return NextResponse.json({ code: "rows_failed", message: "行データを保存できませんでした" }, { status: 500 });
	}

	await auth.sb.from("import_batches").update({ storage_path: storagePath }).eq("id", batchId);

	return NextResponse.json({
		batchId,
		sheetName: parsed.sheetName,
		headers: parsed.headers,
		suggestedMapping: suggestColumnMapping(parsed.headers),
		sampleRows: parsed.rows.slice(0, SAMPLE_ROWS),
		totalRows: parsed.totalRows,
		truncated: parsed.truncated,
		duplicateOf: (duplicates ?? []).map((d) => String(d.id)),
	});
}
