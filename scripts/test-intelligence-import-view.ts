/**
 * The import workflow, checked structurally.
 *
 * The staging order is the safety property: upload → mapping → validation →
 * apply, with nothing reaching the evidence ledger until the last step. A UI
 * that let apply be reached before a mapping was confirmed would write
 * whatever the raw cells happened to hold.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IMPORT_FIELDS, METRIC_FIELDS } from "../lib/intelligence/imports/types";

function code(path: string): string {
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

const client = code("components/intelligence-imports/DataManagementClient.tsx");
const upload = code("components/intelligence-imports/ImportUpload.tsx");
const mapping = code("components/intelligence-imports/ColumnMappingReview.tsx");
const validation = code("components/intelligence-imports/ImportValidationTable.tsx");
const history = code("components/intelligence-imports/ImportBatchHistory.tsx");
const page = code("app/[locale]/(market)/analytics/data-management/page.tsx");

// --- the four stages exist, in order ----------------------------------------
{
	const uploadAt = client.indexOf("<ImportUpload");
	const mappingAt = client.indexOf("<ColumnMappingReview");
	const validationAt = client.indexOf("<ImportValidationTable");
	assert.ok(uploadAt >= 0 && mappingAt > uploadAt && validationAt > mappingAt, "the stages render in order");
	// And the order is enforced by what exists, not by a wizard step counter.
	assert.ok(
		/\{batch \?[\s\S]{0,80}<ColumnMappingReview/.test(client),
		"mapping cannot render without an uploaded batch",
	);
	assert.ok(
		/\{batch && validation \?[\s\S]{0,120}<ImportValidationTable/.test(client),
		"validation cannot render without a confirmed mapping",
	);
}
console.log("✓ upload → mapping → validation → apply, enforced by what exists");

// --- apply is unreachable while nothing is valid ---------------------------
{
	assert.ok(
		validation.includes("disabled={validation.counts.valid === 0}"),
		"apply must be disabled while zero rows are valid",
	);
	assert.ok(validation.includes("nothingToApply"), "and must say why, not just be inert");
	assert.ok(validation.includes("confirming"), "apply takes a second confirmation");
	assert.ok(validation.includes("confirmSentence"), "which states how many rows will be written");
}
console.log("✓ apply is disabled and explained while no row is valid");

// --- invalid rows show their exact error and Excel row number ---------------
{
	assert.ok(validation.includes("row.errors.join"), "the exact errors are rendered, not a count");
	assert.ok(validation.includes("row.rowNumber"), "with the row number the operator sees in Excel");
	assert.ok(
		validation.includes("invalid.slice(0, 50)"),
		"a long error list is bounded rather than rendering ten thousand rows",
	);
}
console.log("✓ invalid rows show their exact error against an Excel row number");

// --- performance columns are labelled optional ------------------------------
// The common case is a product master with no cost data, and an operator who
// assumes the feature is not for them.
{
	assert.ok(upload.includes("optionalColumns"), "the upload step says product info alone is enough");
	assert.ok(mapping.includes("OPTIONAL_METRIC"), "metric fields are marked optional in the mapping table");
	assert.ok(mapping.includes("METRIC_FIELDS"), "the optional set comes from the field list, not a copy");
	const messages = JSON.parse(readFileSync("messages/ja.json", "utf8")) as Record<string, never>;
	const imports = messages.imports as unknown as Record<string, Record<string, Record<string, string>>>;
	for (const field of IMPORT_FIELDS) {
		assert.ok(imports.mapping.field?.[field], `ja is missing a label for ${field}`);
	}
	const ko = JSON.parse(readFileSync("messages/ko.json", "utf8")) as Record<string, never>;
	const koImports = ko.imports as unknown as Record<string, Record<string, Record<string, string>>>;
	for (const field of IMPORT_FIELDS) {
		assert.ok(koImports.mapping.field?.[field], `ko is missing a label for ${field}`);
	}
	assert.equal(METRIC_FIELDS.length, 8);
}
console.log("✓ performance columns are optional and every field is labelled in both locales");

// --- product_name is the one hard requirement -------------------------------
{
	assert.ok(
		mapping.includes("disabled={pending || !mapping.product_name}"),
		"the confirm button is inert without a product name mapping",
	);
	assert.ok(mapping.includes("productNameRequired"), "and says so rather than being silently disabled");
}
console.log("✓ product_name is required, and its absence is explained");

// --- rollback demands a reason ----------------------------------------------
{
	assert.ok(history.includes("reason.trim().length < MIN_REASON"), "rollback is inert without a reason");
	assert.ok(history.includes("reasonPlaceholder"), "and asks for one in words");
	assert.ok(
		history.includes("rollbackNote"),
		"the operator is told what a rollback does — revoke for future use, not erase history",
	);
	assert.ok(history.includes("ROLLBACKABLE"), "only an applied or partial batch offers rollback");
}
console.log("✓ rollback requires a typed reason and explains what it does");

// --- the page is member|admin ------------------------------------------------
{
	assert.ok(
		/requireUser\(\[\s*"member",\s*"admin"\s*\]\)/.test(page),
		"a viewer must not reach file names or cost data",
	);
	assert.ok(page.includes("redirect("), "a Page redirects rather than returning auth.error");
	assert.ok(!page.includes("return auth.error"));

	const nav = code("lib/nav/groups.ts");
	assert.ok(nav.includes("/analytics/data-management"), "the page is in the nav");
	assert.ok(
		/nav\.market\.dataManagement[\s\S]{0,160}roles: \['admin', 'member'\]/.test(nav),
		"and is member|admin only",
	);

	// The readiness CTA is gated separately: coverage numbers are visible to a
	// viewer, the page behind the link is not.
	const pipeline = code("app/[locale]/(market)/analytics/pipeline/page.tsx");
	assert.ok(pipeline.includes("dataManagement={"), "the readiness panel links to the import page");
	assert.ok(
		/dataManagement=\{\s*canWrite\s*\?/.test(pipeline),
		"a viewer sees import coverage but not the link to the files behind it",
	);
}
console.log("✓ the page and its CTA are member|admin, while coverage stays visible to a viewer");

// --- the client never writes evidence itself --------------------------------
{
	for (const [name, source] of [
		["client", client],
		["upload", upload],
		["mapping", mapping],
		["validation", validation],
		["history", history],
	] as Array<[string, string]>) {
		assert.equal(
			source.includes("evidence_items"),
			false,
			`${name} must not touch the ledger directly`,
		);
	}
	const endpoints = [
		...client.matchAll(/fetch\(\s*[`"']([^`"'$]+)/g),
		...upload.matchAll(/fetch\(\s*[`"']([^`"'$]+)/g),
		...mapping.matchAll(/fetch\(\s*[`"']([^`"'$]+)/g),
		...validation.matchAll(/fetch\(\s*[`"']([^`"'$]+)/g),
		...history.matchAll(/fetch\(\s*[`"']([^`"'$]+)/g),
	].map((m) => m[1]);
	for (const endpoint of endpoints) {
		assert.ok(
			endpoint.startsWith("/api/intelligence/imports"),
			`the import UI must only call its own API, got ${endpoint}`,
		);
	}
}
console.log("✓ every request goes to the import API and nothing writes evidence client-side");

console.log("PASS: intelligence import view");
