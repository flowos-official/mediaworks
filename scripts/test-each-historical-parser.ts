/**
 * Run each registered historical-crawl parser individually against today's
 * JST date and report rows-produced, error, and duration. Used to identify
 * which parsers have silently broken (returning 0 rows without throwing).
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { ALL_PARSERS } from "@/lib/historical-crawl";
import { jstToday } from "@/lib/historical-crawl/types";

async function main() {
	const date = jstToday();
	console.log(`Testing parsers for JST date: ${date}\n`);

	for (const p of ALL_PARSERS) {
		const t0 = Date.now();
		try {
			const rows = await p.fetchToday(date);
			const dur = Date.now() - t0;
			const sampleNames = rows.slice(0, 3).map((r) => r.product_name?.slice(0, 50)).filter(Boolean);
			console.log(
				`[${p.slug.padEnd(10)}] ✓ ${String(rows.length).padStart(3)} rows in ${String(dur).padStart(4)}ms`,
			);
			if (sampleNames.length > 0) {
				for (const n of sampleNames) console.log(`             • ${n}`);
			}
		} catch (err) {
			const dur = Date.now() - t0;
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`[${p.slug.padEnd(10)}] ✗ ERROR in ${String(dur).padStart(4)}ms: ${msg.slice(0, 120)}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
