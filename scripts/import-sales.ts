/**
 * ETL Script: Import TXD weekly sales data from Excel to Supabase
 *
 * Usage:
 *   npx tsx scripts/import-sales.ts --year 2025,2026
 *   npx tsx scripts/import-sales.ts --all
 *
 * Prerequisites:
 *   - .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 *   - Supabase tables created (see plan Phase 1-2)
 */

import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EXCEL_PATH = "E:/japan/TXDレギュラー受注集計表.xlsm";
const CATEGORY_FOLDER = "E:/japan/詳細シート有";
const BATCH_SIZE = 100;

// Load env from .env.local
function loadEnv() {
	const candidates = [".env.local", ".env"];
	const envPath = candidates
		.map((f) => path.resolve(process.cwd(), f))
		.find((p) => fs.existsSync(p));
	if (!envPath) {
		console.error("ERROR: No .env.local or .env found. Run from project root.");
		process.exit(1);
	}
	console.log(`Loading env from: ${envPath}`);
	const content = fs.readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const val = trimmed.slice(eqIdx + 1).trim();
		if (!process.env[key]) process.env[key] = val;
	}
}

loadEnv();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !serviceKey) {
	console.error("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
	process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

// ---------------------------------------------------------------------------
// Category Mapping from folder structure
// ---------------------------------------------------------------------------

const FOLDER_CATEGORY_MAP: Record<string, string> = {
	"01_自社商品": "自社商品",
	"02_キッチン": "キッチン",
	"03_掃除／洗濯": "掃除・洗濯",
	"04_美容／運動器具": "美容・運動",
	"05_医療機器": "医療機器",
	"06_アパレル": "アパレル",
	"07_靴／バッグ／財布": "靴・バッグ",
	"08_化粧品": "化粧品",
	"09_家電／雑貨": "家電・雑貨",
	"10_寝具": "寝具",
	"11_宝飾": "宝飾",
	"12_食品": "食品",
	"13_防災／防犯": "防災・防犯",
	"14_ゴルフ": "ゴルフ",
	"15_その他": "その他",
};

// Keyword-based category inference for products not found in folder structure
const KEYWORD_CATEGORY_MAP: Array<[RegExp, string]> = [
	[/鍋|フライパン|包丁|キッチン|まな板|電気圧力|ｷｯﾁﾝ|ｱｲｸｯｸ|ｽﾄｰﾝﾊﾞﾘｱ|ｸﾚﾊﾞｰｽﾗｲｻｰ|だし|味彩|ﾎﾞﾛｰﾆｬ|ご飯釜|HARIO|ｷｰﾌﾟﾌﾚｯｼｭ|ｶﾞﾗｽﾛｯｸ|ﾆｸｻｽ/i, "キッチン"],
	[/洗浄|掃除|洗濯|ﾓｯﾌﾟ|ﾋﾟｴｰﾙ|ﾀｯﾌﾟﾓｯﾊﾟ|ｶﾋﾞﾊﾟｯﾁ|ﾀｵﾙ|ｴｱｺﾝｸﾘｰﾅｰ|ﾘﾌﾚｯｼｭｼﾞｪｯﾄ|ｽﾃｨｯｸｸﾘｰﾅｰ/i, "掃除・洗濯"],
	[/美容|ｱｲﾛﾝ|ﾍｱ|ﾘﾌｧ|ﾌﾞﾗｼ|ﾈｼﾞｯﾀ|ｼﾗｶﾞﾚｽ|ﾘﾌﾃｨｰ|ﾄﾘｰﾄﾒﾝﾄｶﾗｰ|ﾚﾌｨｰﾈ|ﾐｸﾛﾝ|ﾊﾘﾂﾔ|ｽｷﾝﾌｨｯｸｽ|うるおい|ﾂﾔ肌|ｼｬﾝﾌﾟｰ|ﾁｬｰｶﾞ/i, "美容・運動"],
	[/医療|治療|ｻﾎﾟｰﾀｰ|磁気|ﾌｧｲﾃﾝ|骨盤|腰|膝|ひざ|ﾋﾟﾝﾄｸﾞﾗｽ|ﾈｯｸﾚｽ.*ﾌﾟﾚﾐｱﾑ|腹圧ﾍﾞﾙﾄ|EMS|足裏|ｽﾄﾚｯﾁ|ﾘﾝﾊﾟ|内転筋|ﾋｯﾌﾟﾌｨｯﾀｰ|ｱｲｱｼﾞｬｽﾄ|歩ﾄﾚ|ﾄﾚｰﾅｰ|開脚|ｴｸｻｶﾞﾝ|ﾎﾟｽﾁｬ|SPFｸｰﾙ/i, "医療機器"],
	[/ｱﾊﾟﾚﾙ|ｽﾊﾟﾂ|ﾌﾞｰﾂ|ﾅﾉﾛｰﾀｽ|半纏|ﾎｯﾄﾛｰﾌﾞ|電気毛布|ｶｼﾐﾔ|ｽﾄｰﾙ/i, "アパレル"],
	[/ﾊﾞｯｸﾞ|財布|靴|ﾌｫｰﾏﾙ|ﾘｭｯｸ|ｼｮﾙﾀﾞｰ|ﾎﾟｼｪｯﾄ|ﾎﾟｼｪｯﾄ|ﾚｻﾞｰ|ｻﾝﾀﾞﾙ|ｶﾌﾟﾘﾇｰｳﾞ/i, "靴・バッグ"],
	[/化粧|ﾌｧﾝﾃﾞ|ｼﾜ|ﾃｨﾝﾄ/i, "化粧品"],
	[/家電|ｳｫｯﾁ|ｽﾏｰﾄ|乾燥機|電源|ｿｰﾗｰ|USB|ｱﾀﾞﾌﾟﾀ|ﾎﾟｰﾀﾌﾞﾙ|ﾏｯｻｰｼﾞ|HITO-MOMI|ひともみ|ﾒｶﾞﾈｸﾛｽ|暖房器|ｻﾝﾙﾐｴ|加湿器|湯たんぽ|ﾗﾝﾌﾟ|ﾊﾟﾜｰｽﾃｰｼｮﾝ|ﾒｶﾞﾊﾟﾜｰ|ｷｭｰﾋﾞｰ|ﾃﾞｭｵ/i, "家電・雑貨"],
	[/寝具|布団|枕|ﾏｯﾄﾚｽ|ﾍﾞｯﾄﾞ|ｸｯｼｮﾝ/i, "寝具"],
	[/宝飾|ﾀﾞｲﾔ|ﾈｯｸﾚｽ.*ｽﾄｰﾝ|ｸﾞﾛｯｾ|真珠|花珠/i, "宝飾"],
	[/食品|缶|ﾏﾇｶ|石鹼|せっけん|東金|味噌|粥|養命酒|大豆|健康生活|ｼﾞｬﾝ/i, "食品"],
	[/防災|防犯|SONAENO|寝袋/i, "防災・防犯"],
	[/ｺﾞﾙﾌ|ﾄﾞﾗｲﾊﾞｰ|ｱｲｱﾝ|DANGAN|maruman|K2K|ﾊﾟﾀｰ|ﾏｸﾞﾚｶﾞｰ|ﾕｰﾃｨﾘﾃｨ|ﾁｯﾋﾟﾝｸﾞ|ﾄﾙﾈｰﾄﾞ|ｷｬﾝﾍﾟｰﾝﾎﾞｰﾙ|ｳｴｯｼﾞ/i, "ゴルフ"],
	[/刃物|研ぎ|ﾊｻﾐ|ﾑﾃｷ|ｿﾘﾝｸﾞ|ｲﾝｿｰﾙ/i, "家電・雑貨"],
	[/除草|庭師|圧縮|収納|断熱|遮熱|ｾｷｽｲ|ﾌｧｽﾅｰ|ﾀﾞﾆﾋﾟｯﾄ|氷ﾘﾝｸﾞ|ｼﾞｪﾙ|ひんやり|ｳｫｯｼｭﾎｰｽ|ｱﾝﾌﾞﾚﾗ|木陰|ｲｰｼﾞｰPON|運ぶ/i, "家電・雑貨"],
	[/ﾙﾈｻﾝｽ|ｷｭｰﾌｨｯﾀ|ｽﾀｲﾘｰﾎﾞｰﾙ|ﾄﾞｸﾀｰｴｱ|ｸﾞﾙﾗﾎﾞ|YONAMINE|ｱｸｱｳｫｯｼｭ|ﾏｼﾞｶﾙｳｫｯｼｭ|ｽﾘｰｶﾞｰﾄﾞ/i, "医療機器"],
];

function buildCategoryMapFromFolders(): Map<string, string> {
	const map = new Map<string, string>();

	if (!fs.existsSync(CATEGORY_FOLDER)) {
		console.warn(`WARN: Category folder not found: ${CATEGORY_FOLDER}`);
		return map;
	}

	for (const folder of fs.readdirSync(CATEGORY_FOLDER)) {
		const category = FOLDER_CATEGORY_MAP[folder];
		if (!category) continue;

		const folderPath = path.join(CATEGORY_FOLDER, folder);
		if (!fs.statSync(folderPath).isDirectory()) continue;

		for (const file of fs.readdirSync(folderPath)) {
			if (!file.endsWith(".xlsx") && !file.endsWith(".xlsm")) continue;
			if (file.startsWith("~$")) continue;

			// Extract product name keywords from filename
			// Format: "2019.10.01_■かんたん！電気圧力鍋1.2L_新台帳〇.xlsx"
			const nameMatch = file.match(/[■□](.+?)(?:_新台帳|_台帳|\.\w+$)/);
			if (nameMatch) {
				const productName = nameMatch[1]
					.replace(/[\s　【】\[\]()（）]/g, "")
					.replace(/[0-9０-９.]/g, "");
				if (productName.length >= 3) {
					map.set(productName, category);
				}
			}
		}
	}

	console.log(`Built category map from folders: ${map.size} entries`);
	return map;
}

function inferCategory(
	productName: string,
	folderMap: Map<string, string>,
): string | null {
	// 1st: Try folder-based mapping (fuzzy match)
	const normalizedName = productName
		.replace(/[\s　\[\]【】()（）]/g, "")
		.replace(/[0-9０-９.]/g, "");

	for (const [key, category] of folderMap) {
		if (normalizedName.includes(key) || key.includes(normalizedName)) {
			return category;
		}
	}

	// 2nd: Keyword-based inference
	for (const [regex, category] of KEYWORD_CATEGORY_MAP) {
		if (regex.test(productName)) {
			return category;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Date Parsing
// ---------------------------------------------------------------------------

function parseSheetDate(
	sheetName: string,
): { weekStart: string; weekEnd: string; year: number } | null {
	const match = sheetName.match(
		/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*～\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/,
	);
	if (!match) return null;

	const [, y1, m1, d1, y2, m2, d2] = match;
	const weekStart = `${y1}-${m1.padStart(2, "0")}-${d1.padStart(2, "0")}`;
	const weekEnd = `${y2}-${m2.padStart(2, "0")}-${d2.padStart(2, "0")}`;
	return { weekStart, weekEnd, year: parseInt(y1) };
}

// ---------------------------------------------------------------------------
// Main ETL
// ---------------------------------------------------------------------------

async function main() {
	const args = process.argv.slice(2);
	const yearArg = args.find((a) => a.startsWith("--year="))?.split("=")[1];
	const isAll = args.includes("--all");

	const targetYears = yearArg
		? yearArg.split(",").map(Number)
		: isAll
			? []
			: [2025, 2026]; // default

	console.log(
		`Target years: ${targetYears.length ? targetYears.join(", ") : "ALL"}`,
	);
	console.log(`Reading Excel: ${EXCEL_PATH}`);

	const wb = XLSX.readFile(EXCEL_PATH, { type: "file" });
	console.log(`Total sheets: ${wb.SheetNames.length}`);

	// Build category map
	const folderMap = buildCategoryMapFromFolders();

	const salesRows: Array<Record<string, unknown>> = [];
	const totalRows: Array<Record<string, unknown>> = [];
	let skippedSheets = 0;
	let processedSheets = 0;

	for (const sheetName of wb.SheetNames) {
		const parsed = parseSheetDate(sheetName);
		if (!parsed) {
			skippedSheets++;
			continue;
		}

		if (targetYears.length > 0 && !targetYears.includes(parsed.year)) {
			continue;
		}

		const ws = wb.Sheets[sheetName];
		const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
			header: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
			range: 1, // skip header row
		});

		for (const row of rows) {
			const colA = String(row.A ?? "").trim();
			const colB = String(row.B ?? "").trim();
			const colC = String(row.C ?? "").trim();
			const colD = Number(row.D) || 0;
			const colE = Number(row.E) || 0;
			const colF = Number(row.F) || 0;
			const colG = Number(row.G) || 0;
			const colH = Number(row.H) || 0;
			const colI = Number(row.I) || 0;
			const colJ = Number(row.J) || 0;

			if (colA.includes("【合計】")) {
				totalRows.push({
					week_start: parsed.weekStart,
					week_end: parsed.weekEnd,
					total_quantity: colD,
					total_revenue: Math.round(colE),
					total_cost: Math.round(colF),
					total_gross_profit: Math.round(colG),
				});
				continue;
			}

			// Skip subtotal, empty, or header rows
			if (colA.includes("【小計】") || !colB || !colC || colD === 0) continue;

			const category = inferCategory(colC, folderMap);

			salesRows.push({
				week_start: parsed.weekStart,
				week_end: parsed.weekEnd,
				product_code: colB,
				product_name: colC,
				category,
				order_quantity: colD,
				total_revenue: Math.round(colE),
				order_cost: Math.round(colF),
				gross_profit: Math.round(colG),
				wholesale_unit_price: colH ? Math.round(colH) : null,
				purchase_unit_price: colI ? Math.round(colI) : null,
				profit_per_unit: colJ ? Math.round(colJ) : null,
			});
		}

		processedSheets++;
	}

	console.log(
		`Processed: ${processedSheets} sheets, Skipped: ${skippedSheets} (no date in name)`,
	);
	console.log(`Sales rows: ${salesRows.length}, Total rows: ${totalRows.length}`);

	// Category stats
	const catCounts: Record<string, number> = {};
	let uncategorized = 0;
	for (const row of salesRows) {
		if (row.category) {
			catCounts[row.category as string] = (catCounts[row.category as string] || 0) + 1;
		} else {
			uncategorized++;
		}
	}
	console.log("\nCategory distribution:");
	for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${cat}: ${count}`);
	}
	if (uncategorized > 0) {
		console.log(`  [uncategorized]: ${uncategorized}`);
	}

	// Upsert sales data in batches
	let errorCount = 0;
	console.log("\nUpserting sales_weekly...");
	for (let i = 0; i < salesRows.length; i += BATCH_SIZE) {
		const batch = salesRows.slice(i, i + BATCH_SIZE);
		const { error } = await supabase
			.from("sales_weekly")
			.upsert(batch, { onConflict: "week_start,product_code" });

		if (error) {
			console.error(`Batch ${i / BATCH_SIZE + 1} error:`, error.message);
			errorCount++;
		} else {
			process.stdout.write(
				`\r  ${Math.min(i + BATCH_SIZE, salesRows.length)}/${salesRows.length}`,
			);
		}
	}
	console.log("\n  Done.");

	// Upsert totals
	console.log("Upserting sales_weekly_totals...");
	for (let i = 0; i < totalRows.length; i += BATCH_SIZE) {
		const batch = totalRows.slice(i, i + BATCH_SIZE);
		const { error } = await supabase
			.from("sales_weekly_totals")
			.upsert(batch, { onConflict: "week_start" });

		if (error) {
			console.error(`Totals batch error:`, error.message);
			errorCount++;
		}
	}
	console.log("  Done.");

	// Print uncategorized products for review
	if (uncategorized > 0) {
		console.log(`\nUncategorized products (${uncategorized}):`);
		const seen = new Set<string>();
		for (const row of salesRows) {
			if (!row.category && !seen.has(row.product_name as string)) {
				seen.add(row.product_name as string);
				console.log(`  - ${row.product_code}: ${row.product_name}`);
			}
		}
	}

	if (errorCount > 0) {
		console.error(`\nImport completed with ${errorCount} errors.`);
		process.exit(1);
	}

	console.log("\nImport complete!");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
