/**
 * One-off backfill (2026-05-18).
 *
 * Context: the QVC product-page parser was extracting the home-icon link
 * text as `category` for ~all rows ("QVCホームページ … An icon that looks
 * like a house."). The parser is now fixed in lib/qvc-products/fetcher.ts
 * but ~1k existing qvc_products rows still hold the broken string and the
 * broadcasts.category cache is downstream of those.
 *
 * Also: the in-UI whitelist had a long-mark typo ("ビューティー" vs QVC's
 * actual "ビューティ"). This script also rewrites the channel_categories
 * row so the admin-editable source of truth matches.
 *
 * Steps:
 *   1. UPDATE channel_categories: rename "ビューティー" -> "ビューティ" (qvc).
 *   2. Refetch all qvc_products rows whose category looks like the broken
 *      home-icon value (or is NULL) and rewrite with the new parser.
 *   3. For each updated qvc_products row, propagate to broadcasts.category
 *      where broadcasts.product_ids[0] == qvc_products.id.
 *
 * Idempotent — safe to re-run.
 *
 * Run: npx tsx scripts/backfill-qvc-category-2026-05-18.ts
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { fetchQvcProduct } from "../lib/qvc-products/fetcher";

const BROKEN_PATTERN = "%QVCホームページ%";
const CONCURRENCY = 3;
const CHUNK_PAUSE_MS = 400;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function main() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		throw new Error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
	}
	const sb = createClient(url, key);

	// Step 1: rename whitelist row.
	{
		console.log("[1/3] Updating channel_categories...");
		const { error } = await sb
			.from("channel_categories")
			.update({ category: "ビューティ" })
			.eq("channel", "qvc")
			.eq("category", "ビューティー");
		if (error) console.warn("  warn:", error.message);
		else console.log('  channel_categories: "ビューティー" -> "ビューティ"');
	}

	// Step 2: refetch broken/null rows.
	console.log("[2/3] Collecting qvc_products needing refetch...");
	const { data: brokenRows, error: listErr } = await sb
		.from("qvc_products")
		.select("id")
		.or(`category.is.null,category.ilike.${BROKEN_PATTERN}`);
	if (listErr) throw new Error(`list: ${listErr.message}`);
	const ids = (brokenRows ?? []).map((r) => (r as { id: string }).id);
	console.log(`  ${ids.length} ids to refetch`);

	let ok = 0;
	let failed = 0;
	const updatedById = new Map<string, string | null>();

	for (let i = 0; i < ids.length; i += CONCURRENCY) {
		const chunk = ids.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			chunk.map(async (id) => ({ id, detail: await fetchQvcProduct(id) })),
		);
		const updates: Array<{
			id: string;
			category: string | null;
			fetched_at: string;
		}> = [];
		for (const r of results) {
			if (!r.detail) {
				failed++;
				continue;
			}
			updates.push({
				id: r.id,
				category: r.detail.category,
				fetched_at: new Date().toISOString(),
			});
			updatedById.set(r.id, r.detail.category);
		}
		if (updates.length > 0) {
			// Use upsert on (id) so we only touch the columns we care about
			// without overwriting unrelated fields like price_text.
			for (const u of updates) {
				const { error } = await sb
					.from("qvc_products")
					.update({ category: u.category, fetched_at: u.fetched_at })
					.eq("id", u.id);
				if (error) {
					console.warn(`  ${u.id} update err: ${error.message}`);
					failed++;
				} else {
					ok++;
				}
			}
		}
		const done = Math.min(i + CONCURRENCY, ids.length);
		if (done % 30 === 0 || done === ids.length) {
			console.log(`  [${done}/${ids.length}] ok=${ok} failed=${failed}`);
		}
		if (i + CONCURRENCY < ids.length) await sleep(CHUNK_PAUSE_MS);
	}
	console.log(`  qvc_products refetched: ok=${ok} failed=${failed}`);

	// Step 3: propagate to broadcasts.category.
	console.log("[3/3] Backfilling broadcasts.category from qvc_products...");
	// Load ALL qvc_products (not just refetched) so we also fix any rows that
	// were correct in qvc_products but never re-attached after enrichment.
	const { data: allProducts, error: prodErr } = await sb
		.from("qvc_products")
		.select("id, category");
	if (prodErr) throw new Error(`products: ${prodErr.message}`);
	const productCategoryById = new Map<string, string | null>();
	for (const r of (allProducts ?? []) as Array<{
		id: string;
		category: string | null;
	}>) {
		productCategoryById.set(r.id, r.category);
	}

	// Get all QVC broadcasts whose product_ids[0] is set.
	const { data: bRows, error: bErr } = await sb
		.from("broadcasts")
		.select("id, product_ids, category")
		.eq("channel", "qvc")
		.not("product_ids", "is", null);
	if (bErr) throw new Error(`broadcasts: ${bErr.message}`);

	let bUpdated = 0;
	let bSkipped = 0;
	const updates: Array<{ id: string; category: string | null }> = [];
	for (const row of (bRows ?? []) as Array<{
		id: string;
		product_ids: string[] | null;
		category: string | null;
	}>) {
		const pid = row.product_ids?.[0];
		if (!pid) {
			bSkipped++;
			continue;
		}
		const newCat = productCategoryById.get(pid);
		if (newCat === undefined) {
			bSkipped++;
			continue;
		}
		if (newCat === row.category) continue; // already correct
		updates.push({ id: row.id, category: newCat });
	}
	console.log(`  ${updates.length} broadcasts rows need category update`);
	for (let i = 0; i < updates.length; i += 100) {
		const chunk = updates.slice(i, i + 100);
		for (const u of chunk) {
			const { error } = await sb
				.from("broadcasts")
				.update({ category: u.category })
				.eq("id", u.id);
			if (error) {
				console.warn(`  broadcast ${u.id} update err: ${error.message}`);
			} else {
				bUpdated++;
			}
		}
		if (i + 100 < updates.length) {
			console.log(`  broadcasts [${i + 100}/${updates.length}] updated=${bUpdated}`);
		}
	}
	console.log(`  broadcasts updated: ${bUpdated}  skipped (no pid match): ${bSkipped}`);

	// Final report
	const { data: tally } = await sb
		.from("broadcasts")
		.select("category")
		.eq("channel", "qvc")
		.gte("air_date", new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
	const dist = new Map<string, number>();
	for (const r of (tally ?? []) as Array<{ category: string | null }>) {
		const k = r.category ?? "<NULL>";
		dist.set(k, (dist.get(k) ?? 0) + 1);
	}
	console.log("\nQVC broadcasts category distribution (last 30d):");
	for (const [k, v] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(" ", v.toString().padStart(4, " "), k);
	}
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
