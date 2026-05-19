/**
 * Paginate through every qvc_products row whose `category` is null or still
 * holds the old broken home-icon string, re-fetch the product page with the
 * fixed parser, and rewrite. The earlier one-shot backfill capped at
 * Supabase's default 1000-row response, so this script picks up the rest.
 *
 * Idempotent — re-runs are cheap because the parser is now deterministic.
 *
 * Run: npm exec tsx -- --env-file=.env.local scripts/refetch-broken-qvc-products.ts
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { fetchQvcProduct } from "../lib/qvc-products/fetcher";

const PAGE_SIZE = 500;
const CONCURRENCY = 3;
const CHUNK_PAUSE_MS = 400;
const BROKEN_PATTERN = "%QVCホームページ%";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function main() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
	const sb = createClient(url, key);

	// Collect every broken/NULL id using ranged pagination on `id`.
	console.log("[1/2] Collecting broken qvc_products ids...");
	const allIds: string[] = [];
	const SLICE = 1000;
	let offset = 0;
	while (true) {
		const { data, error } = await sb
			.from("qvc_products")
			.select("id")
			.or(`category.is.null,category.ilike.${BROKEN_PATTERN}`)
			.order("id", { ascending: true })
			.range(offset, offset + SLICE - 1);
		if (error) throw new Error(`list: ${error.message}`);
		const chunk = (data ?? []) as { id: string }[];
		for (const r of chunk) allIds.push(r.id);
		if (chunk.length < SLICE) break;
		offset += SLICE;
	}
	console.log(`  total ids: ${allIds.length}`);

	// Re-fetch and update.
	console.log("[2/2] Re-fetching and updating qvc_products...");
	let ok = 0;
	let failed = 0;
	for (let i = 0; i < allIds.length; i += CONCURRENCY) {
		const chunk = allIds.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			chunk.map(async (id) => ({ id, detail: await fetchQvcProduct(id) })),
		);
		for (const r of results) {
			if (!r.detail) {
				failed++;
				continue;
			}
			const { error } = await sb
				.from("qvc_products")
				.update({
					category: r.detail.category,
					fetched_at: new Date().toISOString(),
				})
				.eq("id", r.id);
			if (error) {
				console.warn(`  ${r.id} update err: ${error.message}`);
				failed++;
			} else {
				ok++;
			}
		}
		const done = Math.min(i + CONCURRENCY, allIds.length);
		if (done % 60 === 0 || done === allIds.length) {
			console.log(`  [${done}/${allIds.length}] ok=${ok} failed=${failed}`);
		}
		if (i + CONCURRENCY < allIds.length) await sleep(CHUNK_PAUSE_MS);
	}
	console.log(`\nDone. ok=${ok} failed=${failed}`);

	// Tally remaining
	const { count: stillBroken } = await sb
		.from("qvc_products")
		.select("id", { count: "exact", head: true })
		.ilike("category", BROKEN_PATTERN);
	console.log(`qvc_products still broken: ${stillBroken}`);
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
