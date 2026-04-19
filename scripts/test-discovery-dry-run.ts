/**
 * Stage 1 Discovery Pipeline — Dry Run (no DB writes).
 * Usage: npm run test:discovery-dry-run
 *
 * Runs: plan → pool → exclusion → curate.
 * Prints each stage's output summary for manual inspection.
 */

import { getServiceClient } from "@/lib/supabase";
import { buildCategoryPlan, loadRecentPlannedKeywords, loadTopCategories } from "@/lib/discovery/plan";
import { buildPool } from "@/lib/discovery/pool";
import { applyExclusions, loadExclusionContext } from "@/lib/discovery/exclusion";
import { curatePool } from "@/lib/discovery/curate";
import { DEFAULT_LEARNING_STATE, type LearningState } from "@/lib/discovery/types";

async function loadLearningState(): Promise<LearningState> {
	try {
		const sb = getServiceClient();
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("context", "home_shopping")
			.single();
		if (error || !data) return DEFAULT_LEARNING_STATE;
		return {
			exploration_ratio: data.exploration_ratio,
			category_weights: data.category_weights ?? {},
			category_seasonal_weights: data.category_seasonal_weights ?? {},
			rejected_seeds: data.rejected_seeds ?? {
				urls: [],
				brands: [],
				terms: [],
			},
			recent_rejection_reasons: data.recent_rejection_reasons ?? [],
			feedback_sample_size: data.feedback_sample_size ?? 0,
			is_cold_start: data.is_cold_start ?? true,
		};
	} catch {
		return DEFAULT_LEARNING_STATE;
	}
}

function section(title: string): void {
	console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
	section("Discovery Dry-Run");
	console.log("Target: 30 candidates, no DB writes.");

	section("Step 1 · Load Learning State");
	const learning = await loadLearningState();
	console.log(JSON.stringify(learning, null, 2));

	section("Step 2 · Load Top Categories + Recent Keywords");
	const [topCategories, recentlyUsed] = await Promise.all([
		loadTopCategories(),
		loadRecentPlannedKeywords(),
	]);
	console.log(`top_categories (${topCategories.length}):`, topCategories);
	console.log(`recently_used (${recentlyUsed.size}):`, [...recentlyUsed]);

	section("Step 3 · Build Category Plan (Gemini)");
	const plan = await buildCategoryPlan(learning, topCategories, recentlyUsed);
	console.log("plan:", JSON.stringify(plan, null, 2));

	section("Step 4 · Build Pool (Rakuten + Brave)");
	const t0 = Date.now();
	const pool = await buildPool(plan);
	const poolMs = Date.now() - t0;
	console.log(`pool: ${pool.length} items in ${poolMs}ms`);
	const bySource = pool.reduce<Record<string, number>>((acc, p) => {
		acc[p.source] = (acc[p.source] ?? 0) + 1;
		return acc;
	}, {});
	console.log("pool by source:", bySource);
	const byTrack = pool.reduce<Record<string, number>>((acc, p) => {
		acc[p.track] = (acc[p.track] ?? 0) + 1;
		return acc;
	}, {});
	console.log("pool by track:", byTrack);

	section("Step 5 · Load Exclusion Context + Apply Filters");
	const ctx = await loadExclusionContext(learning);
	console.log(
		`exclusion: ${ctx.ownSourcedNames.length} own, ${ctx.recentDiscoveredUrls.size} 7d urls, ${ctx.crossSessionRakutenCodes.size} rakuten codes, ${ctx.rejectedUrls.size} rej.urls, ${ctx.rejectedBrands.size} rej.brands, ${ctx.rejectedTerms.length} rej.terms`,
	);
	const filtered = applyExclusions(pool, ctx);
	console.log(
		`after exclusion: ${filtered.length} items (filtered out ${pool.length - filtered.length})`,
	);

	section("Step 6 · Curate (Gemini) → 30 candidates");
	if (filtered.length === 0) {
		console.warn("No pool items to curate. Aborting.");
		process.exitCode = 1;
		return;
	}
	const t1 = Date.now();
	const candidates = await curatePool(filtered, 30, learning);
	const curMs = Date.now() - t1;
	console.log(`candidates: ${candidates.length} in ${curMs}ms`);

	section("Top 10 Candidates (by tv_fit_score)");
	candidates.slice(0, 10).forEach((c, i) => {
		const price = c.priceJpy ? `¥${c.priceJpy}` : "¥?";
		console.log(
			`${i + 1}. [${c.tvFitScore}] ${c.name.slice(0, 60)} | ${price} | seed=${c.seedKeyword} | ${c.track}`,
		);
		console.log(`    reason: ${c.tvFitReason}`);
	});

	section("Summary");
	console.log(`pool=${pool.length}  filtered=${filtered.length}  candidates=${candidates.length}`);
	const tvCount = candidates.filter((c) => c.track === "tv_proven").length;
	const expCount = candidates.filter((c) => c.track === "exploration").length;
	console.log(`candidates by track: tv=${tvCount}, exploration=${expCount}`);
	const scoreAvg =
		candidates.reduce((s, c) => s + c.tvFitScore, 0) / (candidates.length || 1);
	console.log(`avg tv_fit_score: ${scoreAvg.toFixed(1)}`);
}

main().catch((err) => {
	console.error("DRY-RUN FAILED:", err);
	process.exitCode = 1;
});
