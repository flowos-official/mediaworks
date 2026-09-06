/**
 * Reading a spreadsheet without inventing anything.
 *
 * The distinction the whole file turns on: a BLANK cell is unknown and an
 * explicit 0 is zero. A product that sold none and a product whose quantity
 * column nobody filled in are different facts, and `Number("")` — which is 0 —
 * is exactly how they stop being different. Once that has happened the ranking
 * reports our own data-entry gaps as business results.
 *
 * Runs against real .xlsx fixtures rather than hand-built objects, because the
 * failure modes live in what the xlsx library does with an empty cell.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	MAX_PREVIEW_ROWS,
	normaliseHeader,
	parseCurrency,
	parseDateCell,
	parseWorkbook,
	suggestColumnMapping,
	validateImportRows,
} from "../lib/intelligence/imports/workbook";

const DIR = "scripts/fixtures/intelligence-import";
const read = (name: string) => new Uint8Array(readFileSync(`${DIR}/${name}`));

// --- product information alone is a valid import ----------------------------
{
	const parsed = parseWorkbook(read("minimal-products.xlsx"));
	assert.equal(parsed.sheetName, "Sheet1");
	assert.deepEqual(parsed.headers, ["商品コード", "商品名", "カテゴリ"]);
	assert.equal(parsed.totalRows, 3);
	// Excel row numbers, so an operator can go and fix the row they are told about.
	assert.deepEqual(parsed.rows.map((r) => r.rowNumber), [2, 3, 4]);

	const mapping = suggestColumnMapping(parsed.headers);
	assert.equal(mapping.product_name, "商品名");
	assert.equal(mapping.product_code, "商品コード");
	assert.equal(mapping.category, "カテゴリ");
	assert.equal(mapping.cost_jpy, undefined, "a column that is not there must not be invented");

	const rows = validateImportRows(parsed, mapping);
	assert.equal(rows[0].productName, "静音ブレンダー Pro");
	assert.deepEqual(rows[0].errors, [], "a products-only sheet is valid");
	assert.deepEqual(rows[0].metrics, {}, "unmapped metric columns are absent, not zero");
	// A blank product code is null, never "".
	assert.equal(rows[2].productCode, null);
	assert.equal(rows[2].category, null);
}
console.log("✓ a product-only sheet imports cleanly and invents no metrics");

// --- explicit zero and blank are different ---------------------------------
{
	const parsed = parseWorkbook(read("products-with-performance.xlsx"));
	const mapping = suggestColumnMapping(parsed.headers);
	assert.equal(mapping.quantity, "数量");
	assert.equal(mapping.revenue_jpy, "売上");
	assert.equal(mapping.cost_jpy, "原価");
	assert.equal(mapping.gross_profit_jpy, "粗利");
	assert.equal(mapping.fees_jpy, "手数料");
	assert.equal(mapping.sale_price_jpy, "販売価格");

	const rows = validateImportRows(parsed, mapping);
	const sold = rows.find((r) => r.productCode === "SKU-001")!;
	const blank = rows.find((r) => r.productCode === "SKU-002")!;

	assert.equal(sold.metrics.quantity, 0, "a product that sold zero units sold zero units");
	assert.equal(sold.metrics.revenue_jpy, 0);
	assert.equal(sold.metrics.gross_profit_jpy, 0);
	assert.deepEqual(sold.errors, []);

	assert.equal(blank.metrics.quantity, null, "a blank cell is unknown, not zero");
	assert.equal(blank.metrics.revenue_jpy, null);
	assert.equal(blank.metrics.gross_profit_jpy, null);
	assert.deepEqual(blank.errors, [], "a blank performance cell is not an error");

	// The two must be distinguishable after normalisation, which is the point.
	assert.notEqual(sold.metrics.quantity, blank.metrics.quantity);
}
console.log("✓ an explicit zero stays 0 and a blank stays null");

// --- currency as a human types it -------------------------------------------
{
	const parsed = parseWorkbook(read("products-with-performance.xlsx"));
	const mapping = suggestColumnMapping(parsed.headers);
	const rows = validateImportRows(parsed, mapping);
	const formatted = rows.find((r) => r.productCode === "SKU-003")!;
	assert.equal(formatted.metrics.sale_price_jpy, 9800);
	assert.equal(formatted.metrics.quantity, 1250);
	assert.equal(formatted.metrics.revenue_jpy, 12_250_000);
	assert.equal(formatted.periodStart, "2026-08-01");
	assert.equal(formatted.periodEnd, "2026-08-31");
	assert.deepEqual(formatted.errors, []);
}
console.log("✓ ¥, commas and slashed dates parse as written");

// --- an unreadable cell is an error, never a zero ---------------------------
{
	const parsed = parseWorkbook(read("products-with-performance.xlsx"));
	const mapping = suggestColumnMapping(parsed.headers);
	const rows = validateImportRows(parsed, mapping);
	const broken = rows.find((r) => r.productCode === "SKU-004")!;
	assert.ok(broken.errors.length >= 3, `expected several errors, got ${JSON.stringify(broken.errors)}`);
	assert.ok(broken.errors.some((e) => e.includes("sale_price_jpy")), "「未定」 is not a price");
	assert.ok(broken.errors.some((e) => e.includes("quantity")), "「たくさん」 is not a quantity");
	assert.ok(broken.errors.some((e) => e.includes("cost_jpy")), "a negative cost is a data error");
	assert.ok(broken.errors.some((e) => e.includes("period_start")));
	// And crucially: nothing unreadable leaked in as a number.
	assert.equal(broken.metrics.sale_price_jpy, undefined);
	assert.equal(broken.metrics.quantity, undefined);
	assert.equal(broken.metrics.cost_jpy, undefined);
}
console.log("✓ an unreadable or negative cell becomes a row error, never a number");

// --- a missing product name is the only hard requirement --------------------
{
	const parsed = parseWorkbook(read("minimal-products.xlsx"));
	// Deliberately drop the name mapping.
	const rows = validateImportRows(parsed, { product_code: "商品コード" });
	assert.ok(rows.every((r) => r.errors.some((e) => e.includes("商品名"))));
}
console.log("✓ product_name is required and its absence is reported per row");

// --- header normalisation ----------------------------------------------------
{
	assert.equal(normaliseHeader("売上 金額"), "売上金額");
	assert.equal(normaliseHeader("Sale Price (JPY)"), "salepricejpy");
	assert.equal(normaliseHeader("ＳＫＵ"), "sku");
	// Full-width and half-width headers are the same column.
	assert.equal(normaliseHeader("商品名"), normaliseHeader("商　品　名".replace(/　/g, "")));

	const mapping = suggestColumnMapping(["Product Name", "Sale Price", "Qty", "상품명"]);
	assert.equal(mapping.product_name, "Product Name", "the first exact match wins");
	assert.equal(mapping.sale_price_jpy, "Sale Price");
	assert.equal(mapping.quantity, "Qty");
	// One header is claimed by at most one field.
	const claimed = Object.values(mapping);
	assert.equal(new Set(claimed).size, claimed.length, "no header may be mapped to two fields");
}
console.log("✓ headers normalise across width, case, spacing and language");

// --- currency and date primitives -------------------------------------------
{
	assert.equal(parseCurrency(null), null);
	assert.equal(parseCurrency(""), null);
	assert.equal(parseCurrency("  "), null);
	assert.equal(parseCurrency(0), 0, "zero is a value");
	assert.equal(parseCurrency("0"), 0);
	assert.equal(parseCurrency("¥1,234"), 1234);
	assert.equal(parseCurrency("１２３４"), 1234, "full-width digits are digits");
	assert.equal(parseCurrency("(500)"), -500, "accounting negatives");
	assert.equal(parseCurrency("abc"), undefined);
	assert.equal(parseCurrency(Number.POSITIVE_INFINITY), undefined);
	assert.equal(parseCurrency(Number.NaN), undefined);

	assert.equal(parseDateCell(null), null);
	assert.equal(parseDateCell("2026/08/01"), "2026-08-01");
	assert.equal(parseDateCell("2026年8月1日"), "2026-08-01");
	assert.equal(parseDateCell("nope"), undefined);
	// The off-by-one this file caught: "2026-8-1" is not ISO-8601, so
	// new Date() reads it as LOCAL midnight and toISOString() renders the
	// previous day in JST. A spreadsheet date has no timezone and must not
	// acquire one.
	assert.equal(parseDateCell("2026-8-1"), "2026-08-01");
	assert.equal(parseDateCell("2026.8.1"), "2026-08-01");
	assert.equal(parseDateCell("2026年12月31日"), "2026-12-31");
	assert.equal(parseDateCell("2026-02-31"), undefined, "a date that does not exist is not a date");
	assert.equal(parseDateCell("2026-13-01"), undefined);
	// A Date built by the xlsx library from a serial number is local midnight;
	// reading its UTC components would move it a day the other way.
	assert.equal(parseDateCell(new Date(2026, 7, 1)), "2026-08-01");
	// A Date does NOT survive import_rows.raw_json — it is stored as JSON and
	// read back as an ISO string. Missing this rejected every dated row in a
	// browser-uploaded sheet ("日付として読めません") while the same sheet
	// validated fine in-process, which is why the in-memory e2e never saw it.
	assert.equal(parseDateCell("2026-08-01T09:00:52.000Z"), "2026-08-01");
	assert.equal(
		parseDateCell(new Date(2026, 7, 1).toISOString()),
		"2026-08-01",
		"a local-midnight date stored as the previous day in UTC must come back as the day it was typed",
	);
	assert.equal(parseDateCell("2026-08-01T99:99:99.000Z"), undefined);
}
console.log("✓ blank, zero and unreadable are three different answers");

// --- the preview is capped, and says so -------------------------------------
{
	assert.ok(MAX_PREVIEW_ROWS >= 1000, "the preview cap must be useful");
	const parsed = parseWorkbook(read("minimal-products.xlsx"));
	assert.equal(parsed.truncated, false);
	assert.ok(parsed.rows.length <= MAX_PREVIEW_ROWS);
}
console.log("✓ the preview is bounded and reports truncation");

// --- an empty workbook is empty, not an error -------------------------------
{
	const empty = parseWorkbook(new Uint8Array(readFileSync(`${DIR}/minimal-products.xlsx`)).slice(0, 0));
	assert.equal(empty.headers.length, 0);
	assert.equal(empty.rows.length, 0);
}
console.log("✓ an unreadable workbook yields nothing rather than throwing");

console.log("PASS: intelligence workbook");
