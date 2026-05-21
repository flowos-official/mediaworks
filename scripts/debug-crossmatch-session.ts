/**
 * Pull actual TV-channel product names from a recent session and run
 * findRakutenCrossMatch against them to see why matching is failing.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getServiceClient } from "@/lib/supabase";
import { findRakutenCrossMatch, __test } from "@/lib/discovery/rakuten-crossmatch";

async function main() {
	const sb = getServiceClient();

	const { data, error } = await sb
		.from("discovered_products")
		.select("name, tv_channel_source, product_url")
		.eq("source", "tv_channel")
		.gte("created_at", new Date(Date.now() - 6 * 3600 * 1000).toISOString())
		.limit(15);

	if (error) {
		console.error(error.message);
		process.exit(1);
	}

	const rows = data ?? [];
	console.log(`Testing crossmatch against ${rows.length} live TV-channel names\n`);

	for (const r of rows) {
		console.log(`--- ch=${r.tv_channel_source} ---`);
		console.log(`  name: "${r.name.slice(0, 90)}"`);
		const tokens = __test.tokenize(r.name);
		console.log(`  tokens (after strip): ${JSON.stringify(tokens)}`);
		try {
			const m = await findRakutenCrossMatch(r.name);
			if (m) {
				console.log(
					`  ✓ MATCH: ★${m.reviewAvg.toFixed(1)} (${m.reviewCount}件) — ${m.itemName.slice(0, 60)}`,
				);
			} else {
				console.log(`  ✗ no match`);
			}
		} catch (err) {
			console.log(`  ! error: ${err instanceof Error ? err.message : err}`);
		}
		await new Promise((r) => setTimeout(r, 1100));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
