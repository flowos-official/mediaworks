/**
 * Inspect the latest home_shopping + live_commerce discovery sessions in
 * detail: broadcast + hot-set annotations, score distribution, full 30-row
 * dump per run for qualitative review. Intended for post-run sanity checks
 * where both pipeline health AND product quality need judgement.
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-discovery-run.ts
 */

import { getServiceClient } from "@/lib/supabase";
import type { Context } from "@/lib/discovery/types";

interface DiscoveredRow {
	name: string;
	price_jpy: number | null;
	tv_fit_score: number;
	tv_fit_reason: string;
	broadcast_tag: string;
	track: string;
	review_count: number | null;
	review_avg: number | null;
	rakuten_item_code: string | null;
	category: string;
	seller_name: string | null;
	is_tv_applicable: boolean;
	is_live_applicable: boolean;
}

async function inspectContext(context: Context): Promise<void> {
	const sb = getServiceClient();

	const { data: run, error: runErr } = await sb
		.from("discovery_runs")
		.select(
			"id, context, status, produced_count, iterations, run_at, completed_at, category_plan",
		)
		.eq("context", context)
		.order("run_at", { ascending: false })
		.limit(1)
		.single();
	if (runErr || !run) {
		console.error(`[${context}] no run:`, runErr?.message);
		return;
	}

	const elapsed =
		run.completed_at && run.run_at
			? Math.round(
					(new Date(run.completed_at).getTime() -
						new Date(run.run_at).getTime()) /
						1000,
				)
			: 0;

	console.log(`\n╔══════════════════════════════════════════════════`);
	console.log(`║ ${context.toUpperCase()} — session ${run.id.slice(0, 8)}`);
	console.log(`║ status=${run.status}  produced=${run.produced_count}  iterations=${run.iterations}  ${elapsed}s`);
	console.log(`╚══════════════════════════════════════════════════`);

	if (run.category_plan) {
		const plan = run.category_plan as {
			tv_proven?: string[];
			exploration?: string[];
			reasoning?: string;
		};
		console.log(`\n▸ Plan:`);
		console.log(`   tv_proven (${plan.tv_proven?.length ?? 0}): ${plan.tv_proven?.join(" · ") ?? ""}`);
		console.log(`   exploration (${plan.exploration?.length ?? 0}): ${plan.exploration?.join(" · ") ?? ""}`);
		if (plan.reasoning) console.log(`   reasoning: ${plan.reasoning}`);
	}

	const { data: products, error: prodErr } = await sb
		.from("discovered_products")
		.select(
			"name, price_jpy, tv_fit_score, tv_fit_reason, broadcast_tag, track, review_count, review_avg, rakuten_item_code, category, seller_name, is_tv_applicable, is_live_applicable",
		)
		.eq("session_id", run.id)
		.order("tv_fit_score", { ascending: false });
	if (prodErr) {
		console.error(`[${context}] products query failed:`, prodErr.message);
		return;
	}
	const rows = (products ?? []) as DiscoveredRow[];

	// Distributions
	const tagCounts = new Map<string, number>();
	const trackCounts = new Map<string, number>();
	const priceBands = { under3k: 0, m3_10: 0, m10_30: 0, over30: 0, noprice: 0 };
	const reviewBands = { highQualHigh: 0, highQualLow: 0, midQual: 0, lowQual: 0, none: 0 };
	let broadcastBoosts = 0;
	let hotSetBoosts = 0;
	const categorySet = new Set<string>();

	for (const r of rows) {
		tagCounts.set(r.broadcast_tag, (tagCounts.get(r.broadcast_tag) ?? 0) + 1);
		trackCounts.set(r.track, (trackCounts.get(r.track) ?? 0) + 1);
		categorySet.add(r.category);

		const p = r.price_jpy ?? 0;
		if (!p) priceBands.noprice++;
		else if (p < 3000) priceBands.under3k++;
		else if (p < 10000) priceBands.m3_10++;
		else if (p < 30000) priceBands.m10_30++;
		else priceBands.over30++;

		const rc = r.review_count ?? 0;
		const ra = r.review_avg ?? 0;
		if (rc === 0) reviewBands.none++;
		else if (ra >= 4.3 && rc >= 100) reviewBands.highQualHigh++;
		else if (ra >= 4.0 && rc >= 30) reviewBands.highQualLow++;
		else if (ra >= 3.5) reviewBands.midQual++;
		else reviewBands.lowQual++;

		if (
			r.tv_fit_reason.includes("放送実績あり") ||
			r.tv_fit_reason.includes("放送兆候あり")
		)
			broadcastBoosts++;
		if (r.tv_fit_reason.includes("楽天リアルタイムランキング上位")) hotSetBoosts++;
	}

	console.log(`\n▸ Distributions (N=${rows.length}):`);
	console.log(
		`   track:     ${[...trackCounts].map(([k, v]) => `${k}=${v}`).join("  ")}`,
	);
	console.log(
		`   broadcast: ${[...tagCounts].map(([k, v]) => `${k}=${v}`).join("  ")}`,
	);
	console.log(
		`   price:     <3k=${priceBands.under3k}  3-10k=${priceBands.m3_10}  10-30k=${priceBands.m10_30}  >30k=${priceBands.over30}  nil=${priceBands.noprice}`,
	);
	console.log(
		`   review:    ★4.3+ ×100+=${reviewBands.highQualHigh}  ★4.0+ ×30+=${reviewBands.highQualLow}  ★3.5+=${reviewBands.midQual}  ★<3.5=${reviewBands.lowQual}  none=${reviewBands.none}`,
	);
	console.log(`   categories: ${categorySet.size} unique seeds`);
	console.log(
		`   boost annotations: broadcast=${broadcastBoosts}  rakuten_hot=${hotSetBoosts}`,
	);

	const avg = rows.reduce((s, r) => s + r.tv_fit_score, 0) / (rows.length || 1);
	const max = rows.length > 0 ? rows[0].tv_fit_score : 0;
	const min = rows.length > 0 ? rows[rows.length - 1].tv_fit_score : 0;
	console.log(
		`   score: avg=${avg.toFixed(1)}  max=${max}  min=${min}  @100=${rows.filter((r) => r.tv_fit_score === 100).length}`,
	);

	console.log(`\n▸ Full product list (sorted by tv_fit_score):`);
	rows.forEach((r, i) => {
		const price = r.price_jpy ? `¥${r.price_jpy.toLocaleString()}` : "¥?";
		const rev = r.review_count
			? `★${r.review_avg}×${r.review_count}`
			: "no-rev";
		const flags = [
			r.is_tv_applicable ? "TV" : "",
			r.is_live_applicable ? "LV" : "",
			r.broadcast_tag !== "unknown" ? r.broadcast_tag.replace("broadcast_", "B:") : "",
		]
			.filter(Boolean)
			.join("/");
		console.log(
			`  ${String(i + 1).padStart(2)}. [${String(r.tv_fit_score).padStart(3)}] ${r.name.slice(0, 55).padEnd(55)} ${price.padEnd(10)} ${rev.padEnd(15)} ${flags.padEnd(12)} ${r.track === "exploration" ? "EXP" : "TVP"} | ${r.category}`,
		);
		if (
			r.tv_fit_reason.includes("放送") ||
			r.tv_fit_reason.includes("楽天リアル")
		) {
			console.log(`      └─ ${r.tv_fit_reason.slice(0, 160)}`);
		}
	});
}

async function main(): Promise<void> {
	await inspectContext("home_shopping");
	await inspectContext("live_commerce");
}

main().catch((err) => {
	console.error("VERIFY FAILED:", err);
	process.exit(1);
});
