/**
 * Inspect the most recent discovery_runs session to verify new ranking
 * signals landed in the stored rows:
 *  - broadcast_tag distribution (should include confirmed/likely if Brave
 *    surfaced competitor broadcasts for any candidate)
 *  - tv_fit_reason annotations ("[放送実績あり]", "[楽天リアルタイムランキング上位]")
 *    emitted by the in-memory score-boost helpers
 *  - score distribution so the boosted rows cluster near/at the cap
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-discovery-run.ts
 */

import { getServiceClient } from "@/lib/supabase";

interface DiscoveredRow {
	name: string;
	tv_fit_score: number;
	tv_fit_reason: string;
	broadcast_tag: string;
	track: string;
	rakuten_item_code: string | null;
	category: string;
}

async function main(): Promise<void> {
	const sb = getServiceClient();

	const { data: run, error: runErr } = await sb
		.from("discovery_runs")
		.select("id, context, status, produced_count, iterations, run_at, completed_at")
		.eq("context", "home_shopping")
		.order("run_at", { ascending: false })
		.limit(1)
		.single();
	if (runErr || !run) {
		console.error("No run found:", runErr?.message);
		process.exit(1);
	}
	console.log("=== Latest home_shopping run ===");
	console.log(JSON.stringify(run, null, 2));

	const { data: products, error: prodErr } = await sb
		.from("discovered_products")
		.select(
			"name, tv_fit_score, tv_fit_reason, broadcast_tag, track, rakuten_item_code, category",
		)
		.eq("session_id", run.id)
		.order("tv_fit_score", { ascending: false });
	if (prodErr) {
		console.error("products query failed:", prodErr.message);
		process.exit(1);
	}
	const rows = (products ?? []) as DiscoveredRow[];
	console.log(`\n=== ${rows.length} products saved ===`);

	const tagCounts = new Map<string, number>();
	const withBroadcastNote: DiscoveredRow[] = [];
	const withHotSetNote: DiscoveredRow[] = [];
	for (const r of rows) {
		tagCounts.set(r.broadcast_tag, (tagCounts.get(r.broadcast_tag) ?? 0) + 1);
		if (
			r.tv_fit_reason.includes("放送実績あり") ||
			r.tv_fit_reason.includes("放送兆候あり")
		) {
			withBroadcastNote.push(r);
		}
		if (r.tv_fit_reason.includes("楽天リアルタイムランキング上位")) {
			withHotSetNote.push(r);
		}
	}

	console.log("\nbroadcast_tag distribution:");
	for (const [tag, n] of tagCounts) console.log(`  ${tag.padEnd(22)} ${n}`);

	console.log(
		`\ntv_fit_reason annotations — broadcast: ${withBroadcastNote.length}, rakuten_hot: ${withHotSetNote.length}`,
	);

	if (withBroadcastNote.length > 0) {
		console.log("\nFirst 3 with broadcast annotation:");
		for (const r of withBroadcastNote.slice(0, 3)) {
			console.log(
				`  [${r.tv_fit_score}] ${r.name.slice(0, 50)} — ${r.tv_fit_reason.slice(0, 140)}`,
			);
		}
	}
	if (withHotSetNote.length > 0) {
		console.log("\nFirst 3 with rakuten-hot annotation:");
		for (const r of withHotSetNote.slice(0, 3)) {
			console.log(
				`  [${r.tv_fit_score}] ${r.name.slice(0, 50)} — ${r.tv_fit_reason.slice(0, 140)}`,
			);
		}
	}

	const avg =
		rows.reduce((s, r) => s + r.tv_fit_score, 0) / (rows.length || 1);
	const max = rows.length > 0 ? rows[0].tv_fit_score : 0;
	const atCap = rows.filter((r) => r.tv_fit_score === 100).length;
	console.log(
		`\nscore summary: avg=${avg.toFixed(1)}, max=${max}, rows@100=${atCap}`,
	);

	console.log("\nTop 5 rows:");
	for (const r of rows.slice(0, 5)) {
		console.log(
			`  [${r.tv_fit_score}] ${r.name.slice(0, 55)} | ${r.track} | ${r.broadcast_tag}`,
		);
		console.log(`     reason: ${r.tv_fit_reason.slice(0, 140)}`);
	}
}

main().catch((err) => {
	console.error("VERIFY FAILED:", err);
	process.exit(1);
});
