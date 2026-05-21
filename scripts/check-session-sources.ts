/**
 * One-shot diagnostic: inspect a discovery session — when it ran,
 * which sources its candidates came from, and which TV channels (if any).
 *
 * Usage:
 *   npx tsx scripts/check-session-sources.ts <sessionId>
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getServiceClient } from "@/lib/supabase";

async function main() {
	const sessionId = process.argv[2];
	if (!sessionId) {
		console.error("Usage: tsx check-session-sources.ts <sessionId>");
		process.exit(1);
	}

	const sb = getServiceClient();

	const { data: session, error: sErr } = await sb
		.from("discovery_runs")
		.select("id, run_at, completed_at, status, target_count, produced_count, context")
		.eq("id", sessionId)
		.single();
	if (sErr || !session) {
		console.error("Session not found:", sErr?.message);
		process.exit(1);
	}

	console.log("=== Session ===");
	console.log(JSON.stringify(session, null, 2));

	const { data: products, error: pErr } = await sb
		.from("discovered_products")
		.select("id, name, product_url, source, tv_channel_source, tv_tier, tv_fit_score, broadcast_tag")
		.eq("session_id", sessionId);
	if (pErr) {
		console.error("Product fetch failed:", pErr.message);
		process.exit(1);
	}

	const rows = products ?? [];
	console.log(`\n=== Products: ${rows.length} total ===`);

	const bySource = rows.reduce<Record<string, number>>((acc, r) => {
		acc[r.source ?? "(null)"] = (acc[r.source ?? "(null)"] ?? 0) + 1;
		return acc;
	}, {});
	console.log("\nBy source:", bySource);

	const byChannel = rows.reduce<Record<string, number>>((acc, r) => {
		const ch = r.tv_channel_source ?? "(none)";
		acc[ch] = (acc[ch] ?? 0) + 1;
		return acc;
	}, {});
	console.log("\nBy tv_channel_source:", byChannel);

	const tier1 = rows.filter((r) => r.tv_tier === 0);
	console.log(`\nTier-1 (TV) count: ${tier1.length}`);

	console.log("\n=== First 5 products ===");
	for (const r of rows.slice(0, 5)) {
		console.log(`- [${r.source}] tier=${r.tv_tier} fit=${r.tv_fit_score} ch=${r.tv_channel_source ?? "-"}`);
		console.log(`  ${r.product_url}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
