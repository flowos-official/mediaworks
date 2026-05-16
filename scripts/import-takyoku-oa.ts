import { createClient } from "@supabase/supabase-js";
import * as xlsx from "xlsx";
import * as path from "path";

const sb = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const FILE = path.join(process.cwd(), "docs", "他局OA（2020年4月～）.xlsx");
const BATCH_SIZE = 500;

interface SheetMap {
	sheet: string;
	channel: string;
	source_url: string;
}

// Maps each xlsx sheet → tv-channels.ts slug. The source_url is captured from row 0.
const SHEET_MAP: SheetMap[] = [
	{ sheet: "ジャパネット",                  channel: "japanet",  source_url: "https://www.japanet.co.jp/shopping/kaiteki/" },
	{ sheet: "テレ朝じゅん散歩",             channel: "junsanpo", source_url: "https://ropping.tv-asahi.co.jp/junsanpo/" },
	{ sheet: "日テレポシュレ",                channel: "ntv",      source_url: "https://shop.ntv.co.jp/s/tvshopping/" },
	{ sheet: "TBSキニナル",                  channel: "tbs",      source_url: "https://shopping.tbs.co.jp/tbs/shop/tv_top/kininaru" },
	{ sheet: "フジDinos",                    channel: "dinos",    source_url: "https://www.dinos.co.jp/tv/premium/" },
	{ sheet: "ABCせのぶら",                  channel: "senobura", source_url: "https://shop.asahi.co.jp/category/SENOBURA/" },
	{ sheet: "ABCウラのウラまで失礼します", channel: "uranoura", source_url: "https://shop.asahi.co.jp/category/URANADJA/" },
	{ sheet: "読売B-tops",                   channel: "btops",    source_url: "https://www.b-tops.com/" },
];

interface HistoricalRow {
	channel: string;
	air_date: string;
	day_of_week: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string;
	source_sheet: string;
}

/** Parse "4/8/20" → "2020-04-08". Returns null for invalid. */
function parseDate(s: unknown): string | null {
	if (!s) return null;
	const str = String(s).trim();
	const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
	if (!m) return null;
	const mm = parseInt(m[1], 10);
	const dd = parseInt(m[2], 10);
	let yy = parseInt(m[3], 10);
	if (yy < 100) yy += 2000;
	if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
	return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Parse a JP price string. Several formats:
 *   "9 ,980円(税込)"       → 9980 incl
 *   "税込 7,980円"          → 7980 incl
 *   "販売価格： ￥11,900 +消費税" → 11900 excl
 *   "￥69,800 (税込)"       → 69800 incl
 *   "6300円(税抜)"           → 6300 excl
 *   "本体価格 \\6,800 (税込 \\7,480)" → 7480 incl (prefer tax-incl)
 */
function parsePrice(raw: unknown): { price: number | null; incl: boolean | null } {
	if (!raw) return { price: null, incl: null };
	const s = String(raw);

	// Find all numbers, normalized
	const nums = Array.from(s.matchAll(/([0-9][0-9, ]{1,})/g))
		.map((m) => parseInt(m[1].replace(/[, ]/g, ""), 10))
		.filter((n) => Number.isFinite(n) && n >= 100 && n < 10_000_000);

	if (nums.length === 0) return { price: null, incl: null };

	const hasIncl = /税込/.test(s);
	const hasExcl = /税抜|＋消費税|\+消費税/.test(s);

	if (hasIncl && hasExcl) {
		// "本体価格 \\6,800 (税込 \\7,480)" → take the larger as tax-incl
		const price = Math.max(...nums);
		return { price, incl: true };
	}
	if (hasIncl) return { price: Math.max(...nums), incl: true };
	if (hasExcl) return { price: Math.max(...nums), incl: false };
	return { price: Math.max(...nums), incl: null };
}

function loadSheetRows(wb: xlsx.WorkBook, sheetName: string, channel: string, sourceUrl: string): HistoricalRow[] {
	const ws = wb.Sheets[sheetName];
	if (!ws) {
		console.warn(`  [warn] sheet "${sheetName}" missing`);
		return [];
	}
	const aoa = xlsx.utils.sheet_to_json<unknown[]>(ws, {
		header: 1,
		defval: null,
		raw: false,
	});

	const rows: HistoricalRow[] = [];
	// Row 0 is title, row 1 is header → start at row 2.
	for (let i = 2; i < aoa.length; i++) {
		const r = aoa[i];
		const dateRaw = r[0];
		const dow = r[1];
		const name = r[2];
		const priceRaw = r[3];

		const air_date = parseDate(dateRaw);
		if (!air_date) continue; // skip empty trailers
		if (!name || typeof name !== "string") continue;
		const product_name = name.trim();
		if (!product_name || product_name === "OA終了") continue;

		const { price, incl } = parsePrice(priceRaw);

		rows.push({
			channel,
			air_date,
			day_of_week: typeof dow === "string" ? dow.trim().slice(0, 3) : null,
			product_name: product_name.slice(0, 500),
			price_text: typeof priceRaw === "string" ? priceRaw.trim().slice(0, 200) : null,
			price_jpy: price,
			price_is_tax_incl: incl,
			source_url: sourceUrl,
			source_sheet: sheetName,
		});
	}
	return rows;
}

function dedupeByUniqueKey(rows: HistoricalRow[]): HistoricalRow[] {
	const seen = new Set<string>();
	const out: HistoricalRow[] = [];
	for (const r of rows) {
		const k = `${r.channel}|${r.air_date}|${r.product_name}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(r);
	}
	return out;
}

async function upsertBatch(batch: HistoricalRow[]): Promise<number> {
	const { error, count } = await sb
		.from("historical_broadcasts")
		.upsert(batch, {
			onConflict: "channel,air_date,product_name",
			ignoreDuplicates: false,
			count: "exact",
		});
	if (error) {
		console.error("  [err] upsert:", error.message);
		return 0;
	}
	return count ?? batch.length;
}

(async () => {
	const onlyChannel = process.argv.slice(2).find((a) => !a.startsWith("--"));
	console.log("loading workbook…");
	const wb = xlsx.readFile(FILE);
	console.log(`workbook loaded: ${wb.SheetNames.length} sheets\n`);

	let allRows: HistoricalRow[] = [];
	for (const m of SHEET_MAP) {
		if (onlyChannel && m.channel !== onlyChannel) continue;
		const rows = loadSheetRows(wb, m.sheet, m.channel, m.source_url);
		console.log(`  ${m.sheet} (${m.channel}): ${rows.length} parsed`);
		allRows = allRows.concat(rows);
	}

	const deduped = dedupeByUniqueKey(allRows);
	console.log(`\ntotal parsed: ${allRows.length}, after dedup: ${deduped.length}`);

	if (process.argv.includes("--dry-run")) {
		console.log("dry-run mode — first 3 rows preview:");
		console.log(JSON.stringify(deduped.slice(0, 3), null, 2));
		console.log("\nchannel counts:");
		const byCh: Record<string, number> = {};
		for (const r of deduped) byCh[r.channel] = (byCh[r.channel] ?? 0) + 1;
		console.table(byCh);
		return;
	}

	console.log(`\nupserting in batches of ${BATCH_SIZE}…`);
	let inserted = 0;
	for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
		const batch = deduped.slice(i, i + BATCH_SIZE);
		const n = await upsertBatch(batch);
		inserted += n;
		if (i % (BATCH_SIZE * 10) === 0 || i + BATCH_SIZE >= deduped.length) {
			console.log(`  batch ${i / BATCH_SIZE + 1}: +${n} (total ${inserted}/${deduped.length})`);
		}
	}

	console.log(`\ndone. upserted ${inserted}/${deduped.length} rows.`);
})();
