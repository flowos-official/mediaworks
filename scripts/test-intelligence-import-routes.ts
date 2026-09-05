/**
 * The upload path, checked statically.
 *
 * These files carry a company's cost book, and the assertions are about the
 * three ways that goes wrong: the file is not what it says it is, it lands
 * somewhere another user can read it, or a mapping is confirmed against
 * columns that do not exist and reports a clean import of nothing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IMPORT_FIELDS } from "../lib/intelligence/imports/types";

function code(path: string): string {
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

const upload = code("app/api/intelligence/imports/route.ts");
const read = code("app/api/intelligence/imports/[id]/route.ts");
const mapping = code("app/api/intelligence/imports/[id]/mapping/route.ts");
const all: Array<[string, string]> = [
	["upload", upload],
	["read", read],
	["mapping", mapping],
];

// --- every route is gated ----------------------------------------------------
{
	for (const [name, source] of all) {
		assert.ok(
			/requireUser\(\[\s*"member",\s*"admin"\s*\]\)/.test(source),
			`${name} must gate on member|admin`,
		);
		assert.ok(source.includes('if ("error" in auth) return auth.error;'), `${name} must return on auth failure`);
	}
	// A batch belongs to one person. Ownership is filtered in the query, not
	// checked after the read.
	for (const [name, source] of [["read", read], ["mapping", mapping]] as Array<[string, string]>) {
		assert.ok(
			source.includes('.eq("created_by", auth.user.id)'),
			`${name} must scope by owner in the query`,
		);
	}
}
console.log("✓ every import route is member|admin and owner-scoped");

// --- exactly one Excel file, verified by its bytes ---------------------------
{
	assert.ok(upload.includes("files.length !== 1"), "one file per batch — a batch is the unit of rollback");
	assert.ok(upload.includes("checkMagicBytes"), "the declared type is a claim by the browser");
	assert.ok(upload.includes("magic.kind !== \"match\""), "a mismatch must be rejected");
	assert.ok(upload.includes("15 * 1024 * 1024"), "15 MB, matching the bucket's own limit");
	assert.ok(upload.includes("createHash(\"sha256\")"), "the file is hashed for duplicate detection");
	for (const mime of [
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	]) {
		assert.ok(upload.includes(mime), `only Excel types are accepted: missing ${mime}`);
	}
	// A .xlsx is a zip. So is a jar, and so is a docx.
	assert.equal(
		/application\/pdf|image\//.test(upload),
		false,
		"no other content type may reach this bucket",
	);
}
console.log("✓ one Excel file, size-capped, and verified against its own magic bytes");

// --- the file lands under its owner's prefix, privately ---------------------
{
	assert.ok(
		upload.includes("`${auth.user.id}/${batchId}/${safeFileName(file.name)}`"),
		"the storage path must start with the uploader's uid — the bucket policy keys on that segment",
	);
	assert.ok(upload.includes("safeFileName"), "a filename the operator chose must be sanitised");
	assert.ok(
		upload.includes("getServiceClient()") && upload.includes("storage.from(BUCKET).upload"),
		"uploads use service credentials because the bucket grants no INSERT to authenticated",
	);
	assert.ok(upload.includes("upsert: false"), "an upload must never overwrite an existing object");
	// The sanitiser has to remove path traversal, not escape it.
	const sanitiser = upload.slice(upload.indexOf("function safeFileName"));
	assert.ok(/split\(\/\[\/\\\\\]\/\)/.test(sanitiser), "path separators are stripped");
	assert.ok(sanitiser.includes('replace(/\\.{2,}/g'), "repeated dots are collapsed");
}
console.log("✓ the file is stored privately under the uploader's own prefix");

// --- rows are persisted before the preview is returned ----------------------
{
	const rowInsert = upload.indexOf('from("import_rows").insert');
	const responseAt = upload.indexOf("return NextResponse.json({\n\t\tbatchId,");
	assert.ok(rowInsert > 0, "raw rows must be stored");
	assert.ok(
		responseAt === -1 || rowInsert < responseAt,
		"the mapping step must work from what was stored, not from what the client still holds",
	);
	assert.ok(upload.includes("raw_json: row.cells"), "the raw cells are kept verbatim for re-mapping");
}
console.log("✓ raw rows are persisted before the preview is returned");

// --- a duplicate hash warns rather than deciding ----------------------------
{
	assert.ok(upload.includes("duplicateOf"), "a repeated file is reported");
	assert.equal(
		/status:\s*409/.test(upload.slice(upload.indexOf("duplicates"))),
		false,
		"a duplicate must not be rejected — re-importing a corrected month is legitimate",
	);
	assert.ok(
		upload.includes('.eq("file_sha256", fileSha256)'),
		"duplicates are found by content hash, not by file name",
	);
}
console.log("✓ a duplicate upload creates a new batch and warns, rather than deciding for the operator");

// --- the mapping is strict --------------------------------------------------
{
	assert.ok(mapping.includes(".strict()"), "an unknown target field must be rejected, not ignored");
	assert.ok(mapping.includes("IMPORT_FIELDS.map"), "the schema is generated from the field list");
	assert.ok(mapping.includes("product_name_required"), "product_name is the one required mapping");
	assert.ok(
		mapping.includes("unknown_header"),
		"a mapping naming a column that is not there would normalise every row to null and report a clean import of nothing",
	);
	assert.ok(
		mapping.includes("for (const row of rows) for (const key of Object.keys(row.raw_json ?? {})) known.add(key);"),
		"headers are checked against the union of all rows — a sparse sheet can omit a column from row 2",
	);
	assert.ok(
		mapping.includes('validRows > 0 ? "validated" : "failed"'),
		"a batch with no valid row must not reach apply",
	);
	assert.ok(mapping.includes("already_applied"), "remapping an applied batch would orphan its evidence");
	assert.equal(IMPORT_FIELDS.length, 16);
}
console.log("✓ the mapping is strict, verified against the sheet, and cannot skip validation");

// --- nothing here writes evidence -------------------------------------------
// Upload and mapping are staging. The ledger is only touched by apply.
{
	for (const [name, source] of all) {
		assert.equal(
			source.includes("evidence_items"),
			false,
			`${name} must not write evidence — that is the apply step, behind its own confirmation`,
		);
		assert.equal(
			source.includes("canonical_products"),
			false,
			`${name} must not create canonical products`,
		);
	}
}
console.log("✓ upload and mapping stage only; nothing reaches the ledger yet");

console.log("PASS: intelligence import routes");
