/**
 * Aggregate query: across all recent discovered_products, how many
 * tv_channel candidates have a rakuten_cross_match attached? Used to
 * verify the end-to-end cross-match pipeline writes to the new column.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getServiceClient } from "@/lib/supabase";

async function main() {
	const sb = getServiceClient();
	const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

	const { data, error } = await sb
		.from("discovered_products")
		.select("id, source, tv_channel_source, rakuten_cross_match, created_at")
		.eq("source", "tv_channel")
		.gte("created_at", since)
		.order("created_at", { ascending: false })
		.limit(200);

	if (error) {
		console.error(error.message);
		process.exit(1);
	}

	const rows = data ?? [];
	const withMatch = rows.filter((r) => r.rakuten_cross_match);
	console.log(`tv_channel rows in last 24h: ${rows.length}`);
	console.log(`  with rakuten_cross_match: ${withMatch.length}`);
	console.log(`  without:                  ${rows.length - withMatch.length}`);

	if (withMatch.length > 0) {
		console.log("\nSamples with cross-match (most recent):");
		for (const r of withMatch.slice(0, 10)) {
			const m = r.rakuten_cross_match as {
				itemName: string;
				reviewCount: number;
				reviewAvg: number;
				priceJpy: number;
			};
			console.log(`  - ★${m.reviewAvg.toFixed(1)} (${m.reviewCount}件) ¥${m.priceJpy} — ${m.itemName.slice(0, 50)}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
