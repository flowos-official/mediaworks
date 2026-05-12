import { getServiceClient } from "../lib/supabase";
import { sleep } from "../lib/broadcasts/fetch";
import { fetchQvcProduct } from "../lib/qvc-products/fetcher";

function parseArgs(): { staleHours: number; limit: number | null; concurrency: number } {
	const args = process.argv.slice(2);
	const get = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.replace(`--${name}=`, "");
	const staleHours = parseInt(get("stale") ?? "24", 10);
	const limit = get("limit");
	const concurrency = parseInt(get("concurrency") ?? "3", 10);
	return {
		staleHours: Number.isFinite(staleHours) ? staleHours : 24,
		limit: limit ? parseInt(limit, 10) : null,
		concurrency: Math.max(1, Math.min(concurrency, 8)),
	};
}

async function collectIds(staleHours: number, limit: number | null): Promise<string[]> {
	const sb = getServiceClient();

	// 1) distinct product IDs that appear in any QVC broadcast
	const { data: broadcasts, error } = await sb
		.from("broadcasts")
		.select("product_ids")
		.eq("channel", "qvc")
		.not("product_ids", "is", null);
	if (error) throw new Error(`broadcasts fetch: ${error.message}`);

	const ids = new Set<string>();
	for (const row of broadcasts ?? []) {
		const arr = (row as { product_ids: string[] | null }).product_ids;
		if (!arr) continue;
		for (const id of arr) ids.add(id);
	}
	if (ids.size === 0) return [];

	// 2) of those, which are missing OR stale
	const cutoff = new Date(Date.now() - staleHours * 3600_000).toISOString();
	const { data: fresh } = await sb
		.from("qvc_products")
		.select("id")
		.gte("fetched_at", cutoff);
	const freshSet = new Set((fresh ?? []).map((r: { id: string }) => r.id));

	const need = [...ids].filter((id) => !freshSet.has(id));
	need.sort();
	return limit ? need.slice(0, limit) : need;
}

async function fetchInBatches(ids: string[], concurrency: number) {
	const sb = getServiceClient();
	let ok = 0;
	let failed = 0;
	const total = ids.length;

	for (let i = 0; i < ids.length; i += concurrency) {
		const chunk = ids.slice(i, i + concurrency);
		const results = await Promise.all(
			chunk.map(async (id) => {
				const detail = await fetchQvcProduct(id);
				return { id, detail };
			}),
		);
		const rows = results
			.filter((r) => r.detail !== null)
			.map((r) => ({
				id: r.id,
				name: r.detail!.name,
				description: r.detail!.description,
				image_url: r.detail!.image_url,
				image_urls: r.detail!.image_urls,
				video_url: r.detail!.video_url,
				price_text: r.detail!.price_text,
				source_url: r.detail!.source_url,
				fetched_at: new Date().toISOString(),
			}));

		if (rows.length > 0) {
			const { error } = await sb.from("qvc_products").upsert(rows, { onConflict: "id" });
			if (error) {
				console.warn(`  upsert error: ${error.message}`);
				failed += rows.length;
			} else {
				ok += rows.length;
			}
		}
		const failedInChunk = chunk.length - rows.length;
		failed += failedInChunk;

		console.log(`  [${Math.min(i + concurrency, total)}/${total}] ok=${ok} failed=${failed}`);

		// 정중함: 청크 간 600ms 슬립
		if (i + concurrency < ids.length) await sleep(600);
	}
	return { ok, failed };
}

async function main() {
	const { staleHours, limit, concurrency } = parseArgs();
	console.log(
		`QVC product enrichment: stale>${staleHours}h, limit=${limit ?? "∞"}, concurrency=${concurrency}\n`,
	);

	const ids = await collectIds(staleHours, limit);
	console.log(`Need to fetch ${ids.length} product(s).`);
	if (ids.length === 0) {
		console.log("Nothing to do.");
		return;
	}

	const { ok, failed } = await fetchInBatches(ids, concurrency);
	console.log(`\nDone. inserted/updated=${ok}, failed=${failed}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
