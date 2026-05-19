/**
 * Deep analysis: shopch.jp `/json/programprodlist2/{programId}.json` as a
 * direct replacement for the existing Gemini classifier.
 *
 * Measures, for every currently stored ShopCh broadcasts row:
 *   - JSON endpoint coverage (2xx with category vs. missing/null)
 *   - Gemini classification accuracy on rows that have any DB category
 *     (i.e., where Gemini did emit a label) by comparing against JSON
 *   - Full category vocabulary the site actually emits (incl. counts)
 *   - Extra fields available from JSON beyond category (product_ids, brand)
 *
 * Output is structured so the user can decide whether to switch from
 * Gemini to JSON-direct categorization.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const UA = "Mozilla/5.0";
const CONCURRENCY = 4;
const PAUSE_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

interface JsonSlot {
	pgmcategory?: string;
	pgmcategorycode?: string;
	pgmname?: string;
	prodList1?: Array<{ reqPrNo?: string }>;
	otherlist?: Array<{ reqPrNo?: string }>;
	brandname?: string;
	brandcode?: string;
}

interface Stored {
	id: string;
	air_date: string;
	start_time: string;
	program_title: string;
	category: string | null;
}

function programId(r: Stored): string {
	return r.air_date.replace(/-/g, "") + r.start_time.replace(/:/g, "");
}

async function fetchJson(pid: string): Promise<{
	ok: boolean;
	status: number;
	data?: JsonSlot;
}> {
	const url = `https://www.shopch.jp/json/programprodlist2/${pid}.json`;
	try {
		const res = await fetch(url, { headers: { "User-Agent": UA } });
		if (!res.ok) return { ok: false, status: res.status };
		const text = await res.text();
		try {
			return { ok: true, status: 200, data: JSON.parse(text) as JsonSlot };
		} catch {
			return { ok: false, status: 200 };
		}
	} catch {
		return { ok: false, status: 0 };
	}
}

async function main() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
	const sb = createClient(url, key);

	console.log("[1/3] Loading stored ShopCh slots...");
	const allRows: Stored[] = [];
	let offset = 0;
	while (true) {
		const { data } = await sb
			.from("broadcasts")
			.select("id, air_date, start_time, program_title, category")
			.eq("channel", "shopch")
			.order("id")
			.range(offset, offset + 999);
		const chunk = (data ?? []) as Stored[];
		if (chunk.length === 0) break;
		allRows.push(...chunk);
		if (chunk.length < 1000) break;
		offset += 1000;
	}
	console.log(`  total slots: ${allRows.length}`);

	console.log("[2/3] Fetching JSON for each slot...");
	const stats = {
		coverage_ok: 0,
		coverage_404: 0,
		coverage_other_err: 0,
		coverage_invalid_json: 0,
		pgmcategory_present: 0,
		pgmcategory_null_or_empty: 0,
		prodList1_present: 0,
		prodList1_count: 0,
		brand_present: 0,
	};
	const jsonCategories = new Map<string, number>(); // "ファッション (51)" -> count
	const agreement = {
		dbHasCat_jsonHasCat_same: 0,
		dbHasCat_jsonHasCat_diff: 0,
		dbHasCat_jsonNull: 0,
		dbNullCat_jsonHasCat: 0,
		dbNullCat_jsonNull: 0,
	};
	const disagreementSamples: Array<{
		dbCat: string;
		jsonCat: string;
		program: string;
	}> = [];
	const dbNullJsonHasSamples: Array<{
		jsonCat: string;
		program: string;
	}> = [];

	for (let i = 0; i < allRows.length; i += CONCURRENCY) {
		const chunk = allRows.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			chunk.map(async (r) => ({ row: r, fetched: await fetchJson(programId(r)) })),
		);
		for (const { row, fetched } of results) {
			if (!fetched.ok) {
				if (fetched.status === 404) stats.coverage_404++;
				else if (fetched.status === 0) stats.coverage_other_err++;
				else if (fetched.status === 200) stats.coverage_invalid_json++;
				else stats.coverage_other_err++;
				continue;
			}
			stats.coverage_ok++;
			const j = fetched.data!;
			const jsonCat =
				j.pgmcategory && j.pgmcategory.trim().length > 0
					? j.pgmcategory.trim()
					: null;
			const code = j.pgmcategorycode ?? "";
			if (jsonCat) {
				stats.pgmcategory_present++;
				const key = `${jsonCat} (${code})`;
				jsonCategories.set(key, (jsonCategories.get(key) ?? 0) + 1);
			} else {
				stats.pgmcategory_null_or_empty++;
			}

			const prodCount = j.prodList1?.length ?? 0;
			if (prodCount > 0) {
				stats.prodList1_present++;
				stats.prodList1_count += prodCount;
			}
			if (j.brandname) stats.brand_present++;

			const dbCat = row.category;
			if (dbCat && jsonCat) {
				if (dbCat === jsonCat) agreement.dbHasCat_jsonHasCat_same++;
				else {
					agreement.dbHasCat_jsonHasCat_diff++;
					if (disagreementSamples.length < 12) {
						disagreementSamples.push({
							dbCat,
							jsonCat,
							program: row.program_title.slice(0, 50),
						});
					}
				}
			} else if (dbCat && !jsonCat) {
				agreement.dbHasCat_jsonNull++;
			} else if (!dbCat && jsonCat) {
				agreement.dbNullCat_jsonHasCat++;
				if (dbNullJsonHasSamples.length < 12) {
					dbNullJsonHasSamples.push({
						jsonCat,
						program: row.program_title.slice(0, 50),
					});
				}
			} else {
				agreement.dbNullCat_jsonNull++;
			}
		}
		if ((i + CONCURRENCY) % 40 === 0) {
			console.log(`  [${Math.min(i + CONCURRENCY, allRows.length)}/${allRows.length}]`);
		}
		if (i + CONCURRENCY < allRows.length) await sleep(PAUSE_MS);
	}

	console.log("\n[3/3] Results\n");
	console.log("=== Coverage ===");
	console.log("  total slots:", allRows.length);
	console.log("  JSON 200 ok:", stats.coverage_ok);
	console.log("  JSON 404:", stats.coverage_404);
	console.log("  JSON other error:", stats.coverage_other_err);
	console.log("  JSON invalid:", stats.coverage_invalid_json);
	const cov = (stats.coverage_ok / allRows.length) * 100;
	console.log(`  coverage %: ${cov.toFixed(1)}`);

	console.log("\n=== pgmcategory presence (of ok-200 responses) ===");
	console.log("  has pgmcategory:", stats.pgmcategory_present);
	console.log("  pgmcategory null/empty:", stats.pgmcategory_null_or_empty);
	const fillRate =
		stats.coverage_ok === 0
			? 0
			: (stats.pgmcategory_present / stats.coverage_ok) * 100;
	console.log(`  category fill rate among ok responses: ${fillRate.toFixed(1)}%`);

	console.log("\n=== DB Gemini vs JSON agreement ===");
	console.log("  Gemini-cat = JSON-cat (✅ match):", agreement.dbHasCat_jsonHasCat_same);
	console.log("  Gemini-cat ≠ JSON-cat (⚠ disagree):", agreement.dbHasCat_jsonHasCat_diff);
	console.log("  Gemini had cat, JSON null:", agreement.dbHasCat_jsonNull);
	console.log("  Gemini NULL, JSON has cat (= Gemini miss):", agreement.dbNullCat_jsonHasCat);
	console.log("  Both NULL:", agreement.dbNullCat_jsonNull);
	const totalCompared =
		agreement.dbHasCat_jsonHasCat_same + agreement.dbHasCat_jsonHasCat_diff;
	if (totalCompared > 0) {
		const acc = (agreement.dbHasCat_jsonHasCat_same / totalCompared) * 100;
		console.log(
			`  Gemini precision (where both emit): ${acc.toFixed(1)}% (${agreement.dbHasCat_jsonHasCat_same}/${totalCompared})`,
		);
	}

	console.log("\n=== Distinct JSON pgmcategory values (count, name, code) ===");
	for (const [k, v] of [...jsonCategories.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(" ", v.toString().padStart(4), k);
	}

	console.log("\n=== Disagreement samples (DB Gemini ≠ JSON) ===");
	for (const s of disagreementSamples) {
		console.log(
			`  [DB: ${s.dbCat.padEnd(22)}] [JSON: ${s.jsonCat.padEnd(22)}] ${s.program}`,
		);
	}

	console.log("\n=== Gemini-NULL recoveries (would have whitelist match via JSON) ===");
	for (const s of dbNullJsonHasSamples) {
		console.log(`  [JSON: ${s.jsonCat.padEnd(22)}] ${s.program}`);
	}

	console.log("\n=== Extra fields ===");
	console.log("  slots with prodList1 (≥1 product):", stats.prodList1_present);
	console.log("  total prodList1 entries:", stats.prodList1_count);
	console.log(
		"  avg products per slot (when present):",
		stats.prodList1_present === 0
			? 0
			: (stats.prodList1_count / stats.prodList1_present).toFixed(2),
	);
	console.log("  slots with brand:", stats.brand_present);
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
