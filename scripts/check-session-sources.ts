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
		.select(
			"id, name, product_url, source, tv_channel_source, tv_tier, tv_fit_score, broadcast_tag, rakuten_cross_match, tv_evidence",
		)
		.eq("session_id", sessionId);
	if (pErr) {
		console.error("Product fetch failed:", pErr.message);
		process.exit(1);
	}

	type Row = {
		id: string;
		name: string;
		product_url: string;
		source: string | null;
		tv_channel_source: string | null;
		tv_tier: number | null;
		tv_fit_score: number | null;
		broadcast_tag: string | null;
		rakuten_cross_match: {
			itemUrl: string;
			itemName: string;
			reviewCount: number;
			reviewAvg: number;
			priceJpy: number;
			similarityScore: number;
		} | null;
		tv_evidence: { airing_count?: number; recent_30d_count?: number } | null;
	};

	const rows = (products ?? []) as Row[];
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

	const tvItems = rows.filter((r) => r.source === "tv_channel");
	const withCrossMatch = tvItems.filter((r) => r.rakuten_cross_match);
	const withEvidence = tvItems.filter(
		(r) => r.tv_evidence && (r.tv_evidence.airing_count ?? 0) > 0,
	);
	console.log(`\n=== TV-channel popularity basis (${tvItems.length} items) ===`);
	console.log(`  with rakuten_cross_match: ${withCrossMatch.length}`);
	console.log(`  with tv_evidence (放送実績): ${withEvidence.length}`);
	console.log(
		`  data-limited (neither):   ${tvItems.length - withCrossMatch.length - withEvidence.length}`,
	);

	if (withCrossMatch.length > 0) {
		console.log("\n=== Cross-match samples ===");
		for (const r of withCrossMatch.slice(0, 5)) {
			const m = r.rakuten_cross_match!;
			console.log(`- ${r.name.slice(0, 60)}`);
			console.log(
				`    → rakuten: ★${m.reviewAvg.toFixed(1)} (${m.reviewCount}件) ¥${m.priceJpy} [overlap=${m.similarityScore}]`,
			);
		}
	}

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
