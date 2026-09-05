/**
 * What an Excel column can become.
 *
 * The field list is closed and product information alone is valid: an operator
 * who only has a product master can still import it and get canonical products
 * and internal_input product facts out. Performance columns are optional
 * because most spreadsheets in this business do not have them, and a required
 * cost column would mean the useful half never gets imported at all.
 *
 * The distinction that runs through every numeric field: a blank cell is
 * UNKNOWN and an explicit 0 is ZERO. They are different facts about a product,
 * and collapsing them is how a ranking ends up reporting our own data-entry
 * gaps as business results.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */

export const IMPORT_FIELDS = [
	"product_code",
	"product_name",
	"brand",
	"model_name",
	"category",
	"description",
	"list_price_jpy",
	"sale_price_jpy",
	"quantity",
	"revenue_jpy",
	"cost_jpy",
	"fees_jpy",
	"shipping_jpy",
	"gross_profit_jpy",
	"period_start",
	"period_end",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** The numeric half. Every one of these may legitimately be 0. */
export const METRIC_FIELDS = [
	"list_price_jpy",
	"sale_price_jpy",
	"quantity",
	"revenue_jpy",
	"cost_jpy",
	"fees_jpy",
	"shipping_jpy",
	"gross_profit_jpy",
] as const;

export type MetricField = (typeof METRIC_FIELDS)[number];

/** Target field → the operator's own header text. */
export type ColumnMapping = Partial<Record<ImportField, string>>;

export interface ParsedWorkbook {
	sheetName: string;
	headers: string[];
	rows: Array<{ rowNumber: number; cells: Record<string, unknown> }>;
	totalRows: number;
	/** True when the sheet was longer than the preview cap. */
	truncated: boolean;
}

export interface NormalizedImportRow {
	rowNumber: number;
	productName: string;
	productCode: string | null;
	brand: string | null;
	modelName: string | null;
	category: string | null;
	description: string | null;
	/** null means the cell was blank — not zero. Absent from the record means
	 *  the column was never mapped, which is a third thing again. */
	metrics: Partial<Record<MetricField, number | null>>;
	periodStart: string | null;
	periodEnd: string | null;
	errors: string[];
}
