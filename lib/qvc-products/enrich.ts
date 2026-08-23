import { getServiceClient } from "@/lib/supabase";
import { sleep } from "@/lib/broadcasts/fetch";
import { fetchQvcProduct } from "./fetcher";

export interface EnrichResult {
	candidates: number;
	fetched: number;
	failed: number;
}

interface EnrichOptions {
	/** Refetch products whose `fetched_at` is older than this many hours. Default 24. */
	staleHours?: number;
	/** Cap number of IDs to fetch in this run (testing / safety). Default unlimited. */
	limit?: number;
	/** Concurrent in-flight HTTP requests. Default 3. Clamped to [1,8]. */
	concurrency?: number;
	/** Only consider broadcasts on these dates (YYYY-MM-DD). Default: all rows. */
	onlyDates?: string[];
	/** Sleep ms between chunks (politeness). Default 600. */
	chunkPauseMs?: number;
	/** Per-step progress logger; default no-op. */
	onProgress?: (msg: string) => void;
}

/** PostgREST caps an unbounded select at this many rows, so full reads page by it. */
const PAGE_SIZE = 1000;

async function collectIds(options: EnrichOptions): Promise<string[]> {
	const sb = getServiceClient();
	const staleHours = options.staleHours ?? 24;
	const limit = options.limit ?? null;

	const ids = new Set<string>();
	// PostgREST caps an unbounded select at 1000 rows. Both sides of this
	// comparison must be read in full: a truncated broadcast list hides product
	// ids that need fetching, and a truncated freshness list re-fetches products
	// that are already cached — which is what starved the real candidates.
	for (let from = 0; ; from += PAGE_SIZE) {
		let q = sb
			.from("broadcasts")
			.select("product_ids,air_date")
			.eq("channel", "qvc")
			.not("product_ids", "is", null);
		if (options.onlyDates && options.onlyDates.length > 0) {
			q = q.in("air_date", options.onlyDates);
		}
		const { data, error } = await q.order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
		if (error) throw new Error(`broadcasts fetch: ${error.message}`);
		for (const row of data ?? []) {
			const arr = (row as { product_ids: string[] | null }).product_ids;
			if (!arr) continue;
			for (const id of arr) ids.add(id);
		}
		if (!data || data.length < PAGE_SIZE) break;
	}
	if (ids.size === 0) return [];

	const cutoff = new Date(Date.now() - staleHours * 3600_000).toISOString();
	const freshSet = new Set<string>();
	for (let from = 0; ; from += PAGE_SIZE) {
		const { data, error } = await sb
			.from("qvc_products")
			.select("id")
			.gte("fetched_at", cutoff)
			.order("id", { ascending: true })
			.range(from, from + PAGE_SIZE - 1);
		if (error) throw new Error(`qvc_products freshness fetch: ${error.message}`);
		for (const r of (data ?? []) as Array<{ id: string }>) freshSet.add(r.id);
		if (!data || data.length < PAGE_SIZE) break;
	}

	const need = [...ids].filter((id) => !freshSet.has(id));
	need.sort();
	return limit ? need.slice(0, limit) : need;
}

async function fetchInBatches(
	ids: string[],
	concurrency: number,
	pauseMs: number,
	onProgress: (msg: string) => void,
): Promise<{ ok: number; failed: number }> {
	const sb = getServiceClient();
	let ok = 0;
	let failed = 0;
	const total = ids.length;

	for (let i = 0; i < ids.length; i += concurrency) {
		const chunk = ids.slice(i, i + concurrency);
		const results = await Promise.all(
			chunk.map(async (id) => ({ id, detail: await fetchQvcProduct(id) })),
		);
		const rows = results
			.filter((r) => r.detail !== null)
			.map((r) => ({
				id: r.id,
				name: r.detail!.name,
				description: r.detail!.description,
				category: r.detail!.category,
				brand: r.detail!.brand,
				image_url: r.detail!.image_url,
				image_urls: r.detail!.image_urls,
				video_url: r.detail!.video_url,
				price_text: r.detail!.price_text,
				original_price_jpy: r.detail!.original_price_jpy,
				sale_label: r.detail!.sale_label,
				source_url: r.detail!.source_url,
				fetched_at: new Date().toISOString(),
			}));

		if (rows.length > 0) {
			const { error } = await sb
				.from("qvc_products")
				.upsert(rows, { onConflict: "id" });
			if (error) {
				onProgress(`upsert error: ${error.message}`);
				failed += rows.length;
			} else {
				ok += rows.length;
			}
		}
		failed += chunk.length - rows.length;
		onProgress(`[${Math.min(i + concurrency, total)}/${total}] ok=${ok} failed=${failed}`);
		if (i + concurrency < ids.length) await sleep(pauseMs);
	}
	return { ok, failed };
}

export async function enrichQvcProducts(options: EnrichOptions = {}): Promise<EnrichResult> {
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8));
	const pauseMs = options.chunkPauseMs ?? 600;
	const onProgress = options.onProgress ?? (() => {});

	const ids = await collectIds(options);
	if (ids.length === 0) {
		return { candidates: 0, fetched: 0, failed: 0 };
	}
	onProgress(`Fetching ${ids.length} products...`);
	const { ok, failed } = await fetchInBatches(ids, concurrency, pauseMs, onProgress);
	return { candidates: ids.length, fetched: ok, failed };
}

/** Exposed for scripts/test-qvc-enrich-pagination.ts — not part of the runtime API. */
export const __test = { collectIds };
