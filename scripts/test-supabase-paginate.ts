/**
 * Unit tests for selectAllPages. No DB: the builder is a stub that serves rows
 * out of an in-memory array, so page arithmetic is checked directly.
 *   npx tsx scripts/test-supabase-paginate.ts
 */
import { selectAllPages } from "@/lib/supabase/paginate";

let failures = 0;
function ok(cond: boolean, msg: string) {
	if (cond) console.log(`  ok: ${msg}`);
	else { console.error(`  FAIL: ${msg}`); failures++; }
}

function table(rowCount: number, pageSize: number) {
	const all = Array.from({ length: rowCount }, (_, i) => ({ id: i }));
	const calls: Array<[number, number]> = [];
	const build = async ({ from, to }: { from: number; to: number }) => {
		calls.push([from, to]);
		return { data: all.slice(from, Math.min(to + 1, from + pageSize)), error: null };
	};
	return { build, calls };
}

async function main() {
	{
		const { build, calls } = table(2500, 1000);
		const rows = await selectAllPages<{ id: number }>(build);
		ok(rows.length === 2500, `reads past the cap (${rows.length} rows)`);
		ok(calls.length === 3, `pages until short (${calls.length} requests)`);
		ok(rows[0].id === 0 && rows[2499].id === 2499, "keeps order and both ends");
		ok(new Set(rows.map((r) => r.id)).size === 2500, "no duplicates across pages");
	}
	{
		const { build, calls } = table(1000, 1000);
		const rows = await selectAllPages<{ id: number }>(build);
		ok(rows.length === 1000, "exact multiple of the page size is complete");
		ok(calls.length === 2, "asks once more to learn the run ended");
	}
	{
		const { build, calls } = table(0, 1000);
		const rows = await selectAllPages<{ id: number }>(build);
		ok(rows.length === 0 && calls.length === 1, "empty result costs one request");
	}
	{
		const rows = await selectAllPages<{ id: number }>(async () => ({ data: null, error: null }));
		ok(rows.length === 0, "null data is treated as an empty page, not a crash");
	}
	{
		let threw = "";
		try {
			await selectAllPages(async () => ({ data: null, error: { message: "boom" } }), { label: "probe" });
		} catch (e) { threw = (e as Error).message; }
		ok(threw.includes("probe") && threw.includes("boom"), "an error surfaces with its label");
	}
	{
		// A truncated result must never be returned quietly — that is the bug class
		// this helper exists to remove.
		const { build } = table(5000, 1000);
		let threw = "";
		try { await selectAllPages(build, { maxRows: 2000 }); } catch (e) { threw = (e as Error).message; }
		ok(threw.includes("maxRows"), "hitting the ceiling throws instead of truncating");
	}
	{
		const { build, calls } = table(250, 100);
		const rows = await selectAllPages<{ id: number }>(build, { pageSize: 100 });
		ok(rows.length === 250 && calls.length === 3, "honours a custom page size");
	}
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
