/**
 * One-off audit: compare what's currently in `broadcasts` (channel='shopch')
 * against what the live shopch.jp JSON endpoint emits *right now*.
 *
 * Purpose: empirically verify that the recent Gemini→JSON migration
 * (lib/broadcasts/shopch-json.ts + scripts/backfill-broadcasts-category.ts)
 * actually wrote the site's ground-truth values to the DB. Read-only.
 *
 * Run:
 *   npx tsx -r dotenv/config scripts/audit-shopch-json-db.ts \
 *     dotenv_config_path=.env.local
 */
import { createClient } from "@supabase/supabase-js";

const UA = "Mozilla/5.0";
const PAUSE_MS = 250;
const SAMPLE_TARGET = 30;
const NULL_QUOTA = 6; // out of SAMPLE_TARGET, ensure ~20% NULL-category rows

interface Stored {
	id: string;
	air_date: string;
	start_time: string;
	program_title: string;
	category: string | null;
	product_ids: string[] | null;
}

interface JsonSlot {
	pgmcategory?: string;
	pgmcategorycode?: string;
	pgmname?: string;
	prodList1?: Array<{ reqPrNo?: string }>;
}

function programId(r: Pick<Stored, "air_date" | "start_time">): string {
	return r.air_date.replace(/-/g, "") + r.start_time.replace(/:/g, "");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchSlotJson(pid: string): Promise<{
	status: number;
	data: JsonSlot | null;
	rawSnippet: string | null;
}> {
	const url = `https://www.shopch.jp/json/programprodlist2/${pid}.json`;
	try {
		const res = await fetch(url, { headers: { "User-Agent": UA } });
		if (!res.ok) return { status: res.status, data: null, rawSnippet: null };
		const text = await res.text();
		try {
			const parsed = JSON.parse(text) as JsonSlot;
			return { status: 200, data: parsed, rawSnippet: text.slice(0, 200) };
		} catch {
			return { status: 200, data: null, rawSnippet: text.slice(0, 200) };
		}
	} catch {
		return { status: 0, data: null, rawSnippet: null };
	}
}

function arraysEqual(a: string[] | null, b: string[] | null): boolean {
	const aa = a ?? [];
	const bb = b ?? [];
	if (aa.length !== bb.length) return false;
	for (let i = 0; i < aa.length; i++) {
		if (aa[i] !== bb[i]) return false;
	}
	return true;
}

function arrayEmptyOrNull(a: string[] | null): boolean {
	return a === null || a.length === 0;
}

function arraysSemanticallyEqual(a: string[] | null, b: string[] | null): boolean {
	// treat empty array vs null as semantically same
	if (arrayEmptyOrNull(a) && arrayEmptyOrNull(b)) return true;
	return arraysEqual(a, b);
}

function jaccard(a: string, b: string): number {
	const grams = (s: string): Set<string> => {
		const out = new Set<string>();
		const t = s.replace(/\s+/g, "");
		for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
		return out;
	};
	const A = grams(a);
	const B = grams(b);
	if (A.size === 0 && B.size === 0) return 1;
	let inter = 0;
	for (const g of A) if (B.has(g)) inter++;
	const union = A.size + B.size - inter;
	return union === 0 ? 0 : inter / union;
}

async function pickSample(): Promise<Stored[]> {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
	if (!url || !key) {
		throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
	}
	const sb = createClient(url, key);

	// Pull every ShopCh row (we want full date range + chance to find NULLs).
	const all: Stored[] = [];
	let offset = 0;
	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, air_date, start_time, program_title, category, product_ids")
			.eq("channel", "shopch")
			.order("air_date", { ascending: true })
			.range(offset, offset + 999);
		if (error) {
			throw new Error(`supabase fetch failed: ${error.message}`);
		}
		const chunk = (data ?? []) as Stored[];
		if (chunk.length === 0) break;
		all.push(...chunk);
		if (chunk.length < 1000) break;
		offset += 1000;
	}
	if (all.length === 0) return [];

	// Group by date so the sample spans the whole range.
	const byDate = new Map<string, Stored[]>();
	for (const r of all) {
		if (!byDate.has(r.air_date)) byDate.set(r.air_date, []);
		byDate.get(r.air_date)!.push(r);
	}
	const dates = [...byDate.keys()].sort();
	const minDate = dates[0];
	const maxDate = dates[dates.length - 1];
	console.log(
		`[sample] ShopCh total rows=${all.length}, date range=${minDate}..${maxDate}, distinct dates=${dates.length}`,
	);

	const nullRows = all.filter((r) => r.category === null);
	const nonNullRows = all.filter((r) => r.category !== null);
	console.log(
		`[sample] category NULL=${nullRows.length}, non-NULL=${nonNullRows.length}`,
	);

	// Pick NULL_QUOTA spread across distinct dates first; remaining from non-NULL evenly across dates.
	const picked: Stored[] = [];
	const seenIds = new Set<string>();
	const nullByDate = new Map<string, Stored[]>();
	for (const r of nullRows) {
		if (!nullByDate.has(r.air_date)) nullByDate.set(r.air_date, []);
		nullByDate.get(r.air_date)!.push(r);
	}
	const nullDates = [...nullByDate.keys()].sort();
	for (const d of nullDates) {
		if (picked.filter((p) => p.category === null).length >= NULL_QUOTA) break;
		const rows = nullByDate.get(d)!;
		const r = rows[Math.floor(rows.length / 2)];
		if (!seenIds.has(r.id)) {
			picked.push(r);
			seenIds.add(r.id);
		}
	}
	// Top up NULL quota even if we have to draw multiple from the same date.
	for (const r of nullRows) {
		if (picked.filter((p) => p.category === null).length >= NULL_QUOTA) break;
		if (!seenIds.has(r.id)) {
			picked.push(r);
			seenIds.add(r.id);
		}
	}

	// Non-null: spread across date stride to cover full range.
	const remaining = SAMPLE_TARGET - picked.length;
	if (remaining > 0 && nonNullRows.length > 0) {
		// Sort by date then start_time deterministically.
		nonNullRows.sort((a, b) =>
			a.air_date === b.air_date
				? a.start_time.localeCompare(b.start_time)
				: a.air_date.localeCompare(b.air_date),
		);
		const stride = Math.max(1, Math.floor(nonNullRows.length / remaining));
		for (let i = 0; i < nonNullRows.length && picked.length < SAMPLE_TARGET; i += stride) {
			const r = nonNullRows[i];
			if (!seenIds.has(r.id)) {
				picked.push(r);
				seenIds.add(r.id);
			}
		}
		// If still short (e.g. stride math left gaps), top up linearly.
		for (const r of nonNullRows) {
			if (picked.length >= SAMPLE_TARGET) break;
			if (!seenIds.has(r.id)) {
				picked.push(r);
				seenIds.add(r.id);
			}
		}
	}

	picked.sort((a, b) =>
		a.air_date === b.air_date
			? a.start_time.localeCompare(b.start_time)
			: a.air_date.localeCompare(b.air_date),
	);
	return picked;
}

async function main() {
	const sample = await pickSample();
	console.log(`[sample] picked N=${sample.length}\n`);
	if (sample.length === 0) {
		console.log("No ShopCh rows in DB; nothing to audit.");
		return;
	}

	type Verdict =
		| "match"
		| "category_diff"
		| "product_ids_diff"
		| "both_diff"
		| "json_404"
		| "json_other_err"
		| "json_no_category"
		| "json_invalid";
	interface Row {
		id: string;
		air_date: string;
		start_time: string;
		pid: string;
		dbCat: string | null;
		jsonCat: string | null;
		dbPids: string[] | null;
		jsonPids: string[];
		dbTitle: string;
		jsonTitle: string | null;
		titleJaccard: number;
		httpStatus: number;
		verdict: Verdict;
	}
	const rows: Row[] = [];

	for (let i = 0; i < sample.length; i++) {
		const r = sample[i];
		const pid = programId(r);
		const fetched = await fetchSlotJson(pid);
		let verdict: Verdict = "match";
		let jsonCat: string | null = null;
		let jsonPids: string[] = [];
		let jsonTitle: string | null = null;

		if (fetched.status === 404) {
			verdict = "json_404";
		} else if (fetched.status !== 200 || !fetched.data) {
			verdict =
				fetched.status === 200 && fetched.data === null
					? "json_invalid"
					: "json_other_err";
		} else {
			const j = fetched.data;
			jsonCat =
				typeof j.pgmcategory === "string" && j.pgmcategory.trim().length > 0
					? j.pgmcategory.trim()
					: null;
			jsonTitle =
				typeof j.pgmname === "string" && j.pgmname.trim().length > 0
					? j.pgmname.trim()
					: null;
			jsonPids = [];
			if (Array.isArray(j.prodList1)) {
				for (const item of j.prodList1) {
					const v = item?.reqPrNo;
					if (typeof v === "string" && /^\d+$/.test(v)) jsonPids.push(v);
				}
			}

			const catSame = r.category === jsonCat;
			const pidsSame = arraysSemanticallyEqual(r.product_ids, jsonPids);

			if (jsonCat === null) {
				verdict = "json_no_category";
			} else if (!catSame && !pidsSame) {
				verdict = "both_diff";
			} else if (!catSame) {
				verdict = "category_diff";
			} else if (!pidsSame) {
				verdict = "product_ids_diff";
			} else {
				verdict = "match";
			}
		}

		const titleJaccard =
			jsonTitle === null ? 0 : jaccard(r.program_title, jsonTitle);

		rows.push({
			id: r.id,
			air_date: r.air_date,
			start_time: r.start_time,
			pid,
			dbCat: r.category,
			jsonCat,
			dbPids: r.product_ids,
			jsonPids,
			dbTitle: r.program_title,
			jsonTitle,
			titleJaccard,
			httpStatus: fetched.status,
			verdict,
		});

		console.log(
			`  [${String(i + 1).padStart(2, "0")}/${sample.length}] ${r.air_date} ${r.start_time} pid=${pid} status=${fetched.status} verdict=${verdict}`,
		);

		if (i + 1 < sample.length) await sleep(PAUSE_MS);
	}

	// === Aggregates ===
	const N = rows.length;
	const reachable = rows.filter((r) => r.httpStatus === 200 && r.verdict !== "json_invalid");
	const reachableWithCat = reachable.filter((r) => r.jsonCat !== null);
	const catCompared = reachableWithCat; // rows where JSON gave us a category to compare against
	const catExactMatch = catCompared.filter((r) => r.dbCat === r.jsonCat).length;
	const catRate = catCompared.length === 0 ? 0 : (catExactMatch / catCompared.length) * 100;

	const pidsCompared = reachable; // any reachable JSON row, since prodList1 is the ground truth
	const pidsExact = pidsCompared.filter((r) =>
		arraysSemanticallyEqual(r.dbPids, r.jsonPids),
	).length;
	const pidsRate = pidsCompared.length === 0 ? 0 : (pidsExact / pidsCompared.length) * 100;

	const titleAvgJaccard =
		reachable.length === 0
			? 0
			: reachable.reduce((s, r) => s + r.titleJaccard, 0) / reachable.length;

	console.log("\n========================================");
	console.log("AUDIT SUMMARY");
	console.log("========================================");
	console.log(`Sampled rows (N): ${N}`);
	console.log(
		`  reachable (HTTP 200, JSON valid): ${reachable.length}/${N}`,
	);
	console.log(
		`  reachable AND pgmcategory present: ${reachableWithCat.length}/${N}`,
	);
	console.log("\n-- Category (DB vs json.pgmcategory) --");
	console.log(`  exact-match: ${catExactMatch}/${catCompared.length} (${catRate.toFixed(1)}%)`);
	const catDiffs = catCompared.filter((r) => r.dbCat !== r.jsonCat);
	console.log(`  disagreements: ${catDiffs.length}`);
	for (const d of catDiffs) {
		console.log(
			`    [DB="${d.dbCat ?? "<null>"}"] [JSON="${d.jsonCat ?? "<null>"}"] ` +
				`pid=${d.pid} title="${d.dbTitle.slice(0, 40)}"`,
		);
	}

	console.log("\n-- product_ids (DB vs json.prodList1[].reqPrNo, order-sensitive) --");
	console.log(`  exact-match: ${pidsExact}/${pidsCompared.length} (${pidsRate.toFixed(1)}%)`);
	const pidsDiffs = pidsCompared.filter(
		(r) => !arraysSemanticallyEqual(r.dbPids, r.jsonPids),
	);
	console.log(`  disagreements: ${pidsDiffs.length}`);
	for (const d of pidsDiffs) {
		console.log(
			`    pid=${d.pid} title="${d.dbTitle.slice(0, 40)}"\n` +
				`      DB:   ${JSON.stringify(d.dbPids)}\n` +
				`      JSON: ${JSON.stringify(d.jsonPids)}`,
		);
	}

	console.log("\n-- program_title (informational; expected to differ) --");
	console.log(`  avg bigram Jaccard: ${titleAvgJaccard.toFixed(2)}`);
	const titleSamples = reachable.slice(0, 5);
	for (const t of titleSamples) {
		console.log(
			`    [J=${t.titleJaccard.toFixed(2)}] DB:"${t.dbTitle.slice(0, 40)}" / JSON:"${(t.jsonTitle ?? "<null>").slice(0, 40)}"`,
		);
	}

	console.log("\n-- Endpoint failures --");
	const v404 = rows.filter((r) => r.verdict === "json_404");
	const vOther = rows.filter((r) => r.verdict === "json_other_err");
	const vInvalid = rows.filter((r) => r.verdict === "json_invalid");
	const vNoCat = rows.filter((r) => r.verdict === "json_no_category");
	console.log(`  404:            ${v404.length}`);
	for (const v of v404) console.log(`    pid=${v.pid} dbCat=${v.dbCat ?? "<null>"}`);
	console.log(`  other transport err: ${vOther.length}`);
	console.log(`  invalid JSON body: ${vInvalid.length}`);
	console.log(`  200 but pgmcategory null/empty: ${vNoCat.length}`);
	for (const v of vNoCat) console.log(`    pid=${v.pid} dbCat=${v.dbCat ?? "<null>"}`);

	console.log("\n-- Verdict breakdown --");
	const counts = new Map<Verdict, number>();
	for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
	for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${k}: ${v}`);
	}

	console.log("\n-- Per-row detail --");
	for (const r of rows) {
		console.log(
			`  ${r.air_date} ${r.start_time} v=${r.verdict.padEnd(18)} ` +
				`dbCat=${(r.dbCat ?? "<null>").padEnd(12)} jsonCat=${(r.jsonCat ?? "<null>").padEnd(12)} ` +
				`dbPids=${(r.dbPids ?? []).length} jsonPids=${r.jsonPids.length}`,
		);
	}
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
