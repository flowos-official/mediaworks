/**
 * Pull raw rows for the channels showing contradictory counts (senobura,
 * uranoura, tbs, txd) to see what air_dates they actually have.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getServiceClient } from "@/lib/supabase";

async function main() {
	const sb = getServiceClient();

	for (const ch of ["senobura", "uranoura", "tbs", "txd"]) {
		const { data, count } = await sb
			.from("historical_broadcasts")
			.select("air_date, product_name", { count: "exact" })
			.eq("channel", ch)
			.order("air_date", { ascending: false })
			.limit(5);
		console.log(`\n=== ${ch} (total rows: ${count}) ===`);
		for (const r of data ?? []) {
			console.log(`  ${r.air_date} ${r.product_name.slice(0, 60)}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
