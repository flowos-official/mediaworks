/**
 * Live check: candidate selection must read past PostgREST's 1000-row cap.
 *
 * With a stale window wider than the table's history, every cached product
 * counts as fresh, so the only candidates left are ids referenced by a
 * broadcast that have never been fetched. Before pagination both sides
 * truncated at 1000 rows, which returned thousands of already-cached products
 * as "needed" while hiding the ids that actually were.
 *
 * Run: npm run test:qvc-enrich-pagination
 */
import { __test } from "@/lib/qvc-products/enrich";
import { getServiceClient } from "@/lib/supabase";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else { console.log(`✓ ${msg}`); }
}

async function main() {
	const sb = getServiceClient();
	const { count: cached } = await sb.from("qvc_products").select("*", { count: "exact", head: true });
	assert((cached ?? 0) > 1000, `precondition: qvc_products holds more than one page (${cached})`);

	const candidates = await __test.collectIds({ staleHours: 24 * 365 * 20 });
	console.log(`  candidates with a 20-year stale window: ${candidates.length}`);
	assert(candidates.length < (cached ?? 0), "cached products are not re-offered as candidates");

	// Every candidate must be genuinely absent from the cache.
	let present = 0;
	for (let i = 0; i < candidates.length; i += 200) {
		const { data } = await sb.from("qvc_products").select("id").in("id", candidates.slice(i, i + 200));
		present += data?.length ?? 0;
	}
	assert(present === 0, `no candidate is already cached (found ${present})`);

	// A zero-hour window must offer everything referenced, proving the
	// broadcast-side read is not truncated either.
	const all = await __test.collectIds({ staleHours: 0 });
	console.log(`  candidates with a 0-hour stale window: ${all.length}`);
	assert(all.length > 1000, `broadcast product ids are read past one page (${all.length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
