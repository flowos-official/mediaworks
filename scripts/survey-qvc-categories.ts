/**
 * One-off diagnostic: sample N random qvc_products IDs, re-fetch each
 * product page with the fixed parser, and print the distribution of
 * top-level breadcrumb categories. Helps reconcile the in-UI whitelist
 * (`CATEGORIES_BY_CHANNEL.qvc`) with the strings QVC actually uses.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { parseQvcProductHTML } from "../lib/qvc-products/fetcher";

async function main() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
	const sb = createClient(url, key);

	const { data } = await sb
		.from("qvc_products")
		.select("id")
		.order("fetched_at", { ascending: false })
		.limit(80);
	const ids = (data ?? []).map((r) => (r as { id: string }).id);
	console.log("Sampling", ids.length, "product ids...");

	const tally = new Map<string, number>();
	let n404 = 0;
	let nErr = 0;
	for (const id of ids) {
		try {
			const res = await fetch(`https://qvc.jp/product.${id}.html`, {
				headers: { "User-Agent": "Mozilla/5.0" },
			});
			if (!res.ok) {
				if (res.status === 404) n404++;
				else nErr++;
				continue;
			}
			const html = await res.text();
			const cat = parseQvcProductHTML(html, id).category;
			const key = cat ?? "<NULL>";
			tally.set(key, (tally.get(key) ?? 0) + 1);
		} catch {
			nErr++;
		}
		// Polite pacing
		await new Promise((r) => setTimeout(r, 200));
	}

	console.log("\nDistribution:");
	for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(" ", v.toString().padStart(3, " "), k);
	}
	console.log("404:", n404, " err:", nErr);
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
