/**
 * Read a spreadsheet the way a person would, and refuse to guess.
 *
 * Deterministic on purpose: no model is involved in deciding what a column
 * means. Header matching is an alias table an operator can read and correct,
 * and every suggestion is shown for confirmation before anything is written.
 * A model that silently mapped 「原価」 to revenue would produce a plausible
 * margin that nobody could trace back to a decision.
 *
 * The rule that governs every numeric cell: BLANK IS UNKNOWN, ZERO IS ZERO.
 * A product that sold zero units and a product whose quantity column was left
 * empty are different facts, and `Number("")` — which is 0 — is how they stop
 * being different.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import * as XLSX from "xlsx";
import {
	IMPORT_FIELDS,
	METRIC_FIELDS,
	type ColumnMapping,
	type ImportField,
	type MetricField,
	type NormalizedImportRow,
	type ParsedWorkbook,
} from "./types";

/** A preview, not a limit on the file. The apply step reads rows from the
 *  database, so this only bounds what one HTTP response carries. */
export const MAX_PREVIEW_ROWS = 2_000;

/**
 * Header aliases, Japanese / Korean / English. Deliberately conservative:
 * a wrong automatic mapping that looks right is worse than no mapping, because
 * the operator confirms the suggestion and moves on.
 */
const FIELD_ALIASES: Record<ImportField, readonly string[]> = {
	product_code: ["商品コード", "商品cd", "品番", "jan", "sku", "상품코드", "품번", "productcode", "itemcode", "code"],
	product_name: ["商品名", "品名", "商品", "상품명", "제품명", "productname", "itemname", "name", "product"],
	brand: ["ブランド", "メーカー", "브랜드", "제조사", "brand", "maker", "manufacturer"],
	model_name: ["型番", "モデル", "모델", "모델명", "model", "modelname"],
	category: ["カテゴリ", "カテゴリー", "分類", "카테고리", "분류", "category", "genre"],
	description: ["説明", "商品説明", "備考", "설명", "비고", "description", "note", "remarks"],
	list_price_jpy: ["定価", "上代", "参考価格", "정가", "listprice", "msrp", "retailprice"],
	sale_price_jpy: ["販売価格", "売価", "実売価格", "판매가", "판매가격", "saleprice", "sellingprice", "price"],
	quantity: ["数量", "販売数", "販売数量", "出荷数", "수량", "판매수량", "quantity", "qty", "units", "unitssold"],
	revenue_jpy: ["売上", "売上高", "売上金額", "매출", "매출액", "revenue", "sales", "salesamount"],
	cost_jpy: ["原価", "仕入原価", "原価金額", "원가", "매입원가", "cost", "cogs", "costofgoods"],
	fees_jpy: ["手数料", "販売手数料", "수수료", "fee", "fees", "commission"],
	shipping_jpy: ["送料", "配送料", "물류비", "배송비", "shipping", "shippingcost", "freight"],
	gross_profit_jpy: ["粗利", "粗利益", "貢献利益", "매출총이익", "총이익", "grossprofit", "profit", "margin"],
	period_start: ["開始日", "期間開始", "販売開始", "시작일", "기간시작", "periodstart", "startdate", "from"],
	period_end: ["終了日", "期間終了", "販売終了", "종료일", "기간종료", "periodend", "enddate", "to"],
};

/** NFKC, lowercase, and every kind of space and separator removed — a header
 *  typed as `売上 金額` and one typed as `売上金額` are the same column. */
export function normaliseHeader(header: string): string {
	return header
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s　_\-./()（）［\][]/g, "")
		.trim();
}

export function suggestColumnMapping(headers: readonly string[]): ColumnMapping {
	const normalised = headers.map((header) => ({ header, key: normaliseHeader(header) }));
	const mapping: ColumnMapping = {};
	const taken = new Set<string>();

	for (const field of IMPORT_FIELDS) {
		const aliases = FIELD_ALIASES[field];
		// Exact match first, across all headers, before any prefix matching:
		// otherwise 「売価」 can be claimed by list_price_jpy's 「価格」 prefix
		// before sale_price_jpy ever sees it.
		const exact = normalised.find((h) => !taken.has(h.header) && aliases.includes(h.key));
		if (exact) {
			mapping[field] = exact.header;
			taken.add(exact.header);
			continue;
		}
		const partial = normalised.find(
			(h) => !taken.has(h.header) && aliases.some((alias) => alias.length >= 3 && h.key.includes(alias)),
		);
		if (partial) {
			mapping[field] = partial.header;
			taken.add(partial.header);
		}
	}
	return mapping;
}

export function parseWorkbook(buffer: ArrayBuffer | Uint8Array): ParsedWorkbook {
	const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
	// The first sheet that actually has content. A workbook whose first tab is a
	// blank cover sheet is normal, and failing on it would be unhelpful.
	let sheetName = "";
	let rowObjects: Record<string, unknown>[] = [];
	let headers: string[] = [];
	for (const name of workbook.SheetNames) {
		const sheet = workbook.Sheets[name];
		if (!sheet) continue;
		const header = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
		if (header.length < 2) continue;
		const candidateHeaders = (header[0] as unknown[])
			.map((cell) => (cell === null || cell === undefined ? "" : String(cell).trim()))
			.filter(Boolean);
		if (candidateHeaders.length === 0) continue;
		sheetName = name;
		headers = candidateHeaders;
		// `defval: null` is the whole point: without it a blank cell is simply
		// absent from the object and every downstream `?? 0` fills it in.
		rowObjects = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
			defval: null,
			blankrows: false,
			raw: true,
		});
		break;
	}

	if (!sheetName) {
		return { sheetName: "", headers: [], rows: [], totalRows: 0, truncated: false };
	}

	const totalRows = rowObjects.length;
	const rows = rowObjects.slice(0, MAX_PREVIEW_ROWS).map((cells, index) => ({
		// 1 is the header row, so the first data row is 2 — the number the
		// operator sees in Excel when they go to fix an error.
		rowNumber: index + 2,
		cells,
	}));
	return { sheetName, headers, rows, totalRows, truncated: totalRows > MAX_PREVIEW_ROWS };
}

function text(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	const trimmed = String(value).trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * A currency cell. Returns `null` for blank and `undefined` for unparseable —
 * the caller turns the second into a row error rather than into a zero.
 */
export function parseCurrency(value: unknown): number | null | undefined {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (value instanceof Date) return undefined;
	const raw = String(value).trim();
	if (raw === "" || raw === "-" || raw === "—") return null;
	const cleaned = raw
		.normalize("NFKC")
		.replace(/[,\s　]/g, "")
		.replace(/[¥￥円]/g, "")
		.replace(/^\((.*)\)$/, "-$1"); // accounting negatives
	if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
	const parsed = Number(cleaned);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A spreadsheet date is a wall-clock date with no timezone, so it must never be
 * shifted by the server's.
 *
 * Both halves of this were wrong with `new Date(...).toISOString()`. A string
 * like "2026-8-1" is not ISO-8601, so V8 parses it as LOCAL midnight, and in
 * JST that renders back as 2026-07-31 — a silent off-by-one on every
 * single-digit date. And a Date the xlsx library built from a serial number is
 * local midnight too, so reading its UTC components moves it a day the other
 * way. Components are therefore extracted explicitly, and Date objects are read
 * in local time, which is the clock the cell was written against.
 */
export function parseDateCell(value: unknown): string | null | undefined {
	const pad = (n: number) => String(n).padStart(2, "0");
	if (value === null || value === undefined) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return undefined;
		return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	}
	const raw = String(value).trim();
	if (raw === "") return null;
	const normalised = raw.normalize("NFKC").replace(/[年月/.]/g, "-").replace(/日/g, "").trim();
	const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalised);
	if (!match) return undefined;
	const [, year, month, day] = match;
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
	// Round-tripped through UTC purely to reject 2026-02-31, without ever
	// letting a timezone touch the value that comes back.
	const probe = new Date(Date.UTC(y, m - 1, d));
	if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
		return undefined;
	}
	return `${y}-${pad(m)}-${pad(d)}`;
}

/** Fields where a negative value is a data error rather than a small number. */
const NON_NEGATIVE: ReadonlySet<MetricField> = new Set([
	"list_price_jpy",
	"sale_price_jpy",
	"quantity",
	"revenue_jpy",
	"cost_jpy",
	"fees_jpy",
	"shipping_jpy",
]);

export function validateImportRows(
	parsed: ParsedWorkbook,
	mapping: ColumnMapping,
): NormalizedImportRow[] {
	return parsed.rows.map(({ rowNumber, cells }) => {
		const errors: string[] = [];
		const cell = (field: ImportField): unknown => {
			const header = mapping[field];
			return header === undefined ? undefined : cells[header];
		};

		const productName = text(cell("product_name"));
		if (!productName) errors.push("商品名が空です");

		const metrics: NormalizedImportRow["metrics"] = {};
		for (const field of METRIC_FIELDS) {
			if (mapping[field] === undefined) continue; // column never mapped
			const value = parseCurrency(cell(field));
			if (value === undefined) {
				errors.push(`${field}: 数値として読めません`);
				continue;
			}
			if (value !== null && NON_NEGATIVE.has(field) && value < 0) {
				errors.push(`${field}: 負の値は取り込めません`);
				continue;
			}
			// null survives as null. This is the line the whole file is about.
			metrics[field] = value;
		}

		const periodStart = mapping.period_start === undefined ? null : parseDateCell(cell("period_start"));
		if (periodStart === undefined) errors.push("period_start: 日付として読めません");
		const periodEnd = mapping.period_end === undefined ? null : parseDateCell(cell("period_end"));
		if (periodEnd === undefined) errors.push("period_end: 日付として読めません");

		if (
			typeof periodStart === "string" &&
			typeof periodEnd === "string" &&
			periodStart > periodEnd
		) {
			errors.push("期間の開始日が終了日より後です");
		}

		return {
			rowNumber,
			productName: productName ?? "",
			productCode: text(cell("product_code")),
			brand: text(cell("brand")),
			modelName: text(cell("model_name")),
			category: text(cell("category")),
			description: text(cell("description")),
			metrics,
			periodStart: periodStart ?? null,
			periodEnd: periodEnd ?? null,
			errors,
		};
	});
}
