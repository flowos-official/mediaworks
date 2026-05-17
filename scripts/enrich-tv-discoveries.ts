import { createClient } from "@supabase/supabase-js";
import { fetchAndParseMetadata } from "../lib/discovery/tv-channel-enrich";

const sb = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CONCURRENCY = 4;

interface Row {
	id: string;
	name: string;
	product_url: string;
	thumbnail_url: string | null;
	price_jpy: number | null;
	category: string | null;
	tv_channel_source: string;
}

async function processRow(row: Row): Promise<{ ok: boolean; updates: number }> {
	const meta = await fetchAndParseMetadata(row.product_url);
	if (!meta) {
		console.log(`  [skip] ${row.product_url} — fetch failed`);
		return { ok: false, updates: 0 };
	}

	const patch: Record<string, unknown> = {};
	if (!row.thumbnail_url && meta.thumbnail_url) patch.thumbnail_url = meta.thumbnail_url;
	if (row.price_jpy == null && meta.price_jpy != null) patch.price_jpy = meta.price_jpy;
	if (!row.category && meta.category) patch.category = meta.category;

	const updates = Object.keys(patch).length;
	if (updates === 0) {
		console.log(`  [none] ${row.name.slice(0, 50)} — no new fields`);
		return { ok: true, updates: 0 };
	}

	const { error } = await sb
		.from("discovered_products")
		.update(patch)
		.eq("id", row.id);
	if (error) {
		console.error(`  [err]  ${row.id}:`, error.message);
		return { ok: false, updates: 0 };
	}
	console.log(
		`  [ok]   ${row.name.slice(0, 40)} → ${Object.keys(patch).join(", ")}`,
	);
	return { ok: true, updates };
}

async function processInBatches(rows: Row[]) {
	let okCount = 0;
	let updatedCount = 0;
	for (let i = 0; i < rows.length; i += CONCURRENCY) {
		const batch = rows.slice(i, i + CONCURRENCY);
		console.log(`\nbatch ${i / CONCURRENCY + 1} (${batch.length} rows):`);
		const results = await Promise.all(batch.map((r) => processRow(r)));
		for (const r of results) {
			if (r.ok) okCount++;
			updatedCount += r.updates;
		}
	}
	return { okCount, updatedCount };
}

(async () => {
	const onlyMissing = !process.argv.includes("--all");
	let q = sb
		.from("discovered_products")
		.select(
			"id,name,product_url,thumbnail_url,price_jpy,category,tv_channel_source",
		)
		.not("tv_channel_source", "is", null)
		.order("created_at", { ascending: false });

	if (onlyMissing) {
		q = q.is("thumbnail_url", null);
	}
	const { data, error } = await q;
	if (error) {
		console.error("query failed:", error);
		process.exit(1);
	}

	const rows = (data ?? []) as Row[];
	console.log(
		`processing ${rows.length} rows ${onlyMissing ? "(missing thumbnail only)" : "(all tv-channel rows)"}`,
	);
	if (rows.length === 0) {
		console.log("nothing to do.");
		return;
	}

	const { okCount, updatedCount } = await processInBatches(rows);
	console.log(`\ndone. fetched=${okCount}/${rows.length}, updated=${updatedCount}`);
})();
