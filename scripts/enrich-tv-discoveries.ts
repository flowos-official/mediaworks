/**
 * Backfill price / thumbnail / category onto existing tv_channel discovered_products
 * rows (P1-6 slice ③). Mirrors the ingest path (lib/discovery/save.ts):
 *   1. fetch the product page (charset-aware) → enrich ONLY product-validated pages
 *      (JSON-LD @type=Product / og:type=product / extractable price); non-product
 *      or unscrapeable pages are left as-is, never deleted.
 *   2. rows still missing a category → Gemini name-classifier → operator UI label
 *      (the value the pool filter matches).
 *
 * SAFE BY DEFAULT: dry-run (no writes) unless `--apply` is passed.
 *   npx tsx --env-file=.env.local scripts/enrich-tv-discoveries.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/enrich-tv-discoveries.ts --apply    # writes
 */
import { createClient } from "@supabase/supabase-js";
import { fetchAndParseMetadata } from "../lib/discovery/tv-channel-enrich";
import { classifyProductCategories } from "../lib/discovery/tv-channel-category-classify";

const sb = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CONCURRENCY = 4;
const CLASSIFY_CHUNK = 30;
const APPLY = process.argv.includes("--apply");

interface Row {
	id: string;
	name: string;
	product_url: string;
	thumbnail_url: string | null;
	price_jpy: number | null;
	category: string | null;
}

interface Enriched {
	row: Row;
	patch: Record<string, unknown>;
	fetched: boolean;
	isProduct: boolean;
	needsCategory: boolean; // product/kept row still without a category after fetch
}

async function fetchEnrich(row: Row): Promise<Enriched> {
	const meta = await fetchAndParseMetadata(row.product_url);
	const patch: Record<string, unknown> = {};
	if (!meta) {
		// fetch failed (timeout/JS-rendered/40x) — keep row, still try name-classify
		return { row, patch, fetched: false, isProduct: false, needsCategory: !row.category };
	}
	if (!meta.is_product_page) {
		// not a validated product page — do not enrich scraped fields
		return { row, patch, fetched: true, isProduct: false, needsCategory: !row.category };
	}
	if (!row.thumbnail_url && meta.thumbnail_url) patch.thumbnail_url = meta.thumbnail_url;
	if (row.price_jpy == null && meta.price_jpy != null) patch.price_jpy = meta.price_jpy;
	// Category from the name-classifier only (UI labels) — JSON-LD category is
	// channel-vocabulary and not pool-filter-matchable (see save.ts note).
	return { row, patch, fetched: true, isProduct: true, needsCategory: !row.category };
}

async function main() {
	let q = sb
		.from("discovered_products")
		.select("id,name,product_url,thumbnail_url,price_jpy,category")
		.not("tv_channel_source", "is", null)
		.not("product_url", "ilike", "%rakuten.co.jp%")
		.order("created_at", { ascending: false });
	// rows missing any enrichable field
	q = q.or("category.is.null,price_jpy.is.null,thumbnail_url.is.null");

	const { data, error } = await q;
	if (error) {
		console.error("query failed:", error);
		process.exit(1);
	}
	const rows = (data ?? []) as Row[];
	console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — ${rows.length} tv_channel rows missing price/category/thumbnail\n`);
	if (rows.length === 0) {
		console.log("nothing to do.");
		return;
	}

	// Phase A: fetch + enrich (concurrency-bounded)
	const enriched: Enriched[] = [];
	for (let i = 0; i < rows.length; i += CONCURRENCY) {
		const batch = rows.slice(i, i + CONCURRENCY);
		enriched.push(...(await Promise.all(batch.map(fetchEnrich))));
		process.stdout.write(`\r  fetched ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}`);
	}
	process.stdout.write("\n");

	// Phase B: name-classify rows still missing a category
	const toClassify = enriched.filter((e) => e.needsCategory && e.row.name);
	let classified = 0;
	for (let i = 0; i < toClassify.length; i += CLASSIFY_CHUNK) {
		const chunk = toClassify.slice(i, i + CLASSIFY_CHUNK);
		const labels = await classifyProductCategories(chunk.map((e) => ({ name: e.row.name })));
		chunk.forEach((e, k) => {
			if (labels[k]) {
				e.patch.category = labels[k];
				classified++;
			}
		});
		process.stdout.write(`\r  classified ${Math.min(i + CLASSIFY_CHUNK, toClassify.length)}/${toClassify.length}`);
	}
	if (toClassify.length > 0) process.stdout.write("\n");

	// Phase C: write (or report)
	const withPatch = enriched.filter((e) => Object.keys(e.patch).length > 0);
	let priceSet = 0, thumbSet = 0, catSet = 0, fetchFail = 0, nonProduct = 0;
	for (const e of enriched) {
		if (!e.fetched) fetchFail++;
		else if (!e.isProduct) nonProduct++;
		if ("price_jpy" in e.patch) priceSet++;
		if ("thumbnail_url" in e.patch) thumbSet++;
		if ("category" in e.patch) catSet++;
	}

	console.log(
		`\nplan: ${withPatch.length}/${rows.length} rows get updates | price=${priceSet} thumbnail=${thumbSet} category=${catSet} (classified=${classified}) | fetchFail=${fetchFail} nonProduct(skip-enrich)=${nonProduct}`,
	);
	// sample
	for (const e of withPatch.slice(0, 12)) {
		console.log(`  ${Object.keys(e.patch).map((k) => `${k}=${e.patch[k]}`).join(", ")}  ←  ${e.row.name.slice(0, 40)}`);
	}

	if (!APPLY) {
		console.log(`\nDRY-RUN — no writes. Re-run with --apply to persist.`);
		return;
	}

	let written = 0, errs = 0;
	for (let i = 0; i < withPatch.length; i += CONCURRENCY) {
		const batch = withPatch.slice(i, i + CONCURRENCY);
		await Promise.all(
			batch.map(async (e) => {
				const { error: upErr } = await sb.from("discovered_products").update(e.patch).eq("id", e.row.id);
				if (upErr) { errs++; console.error(`  [err] ${e.row.id}: ${upErr.message}`); }
				else written++;
			}),
		);
	}
	console.log(`\nAPPLIED — ${written} rows updated, ${errs} errors.`);
}

main().catch((e) => {
	console.error("FAIL:", e);
	process.exitCode = 1;
});
