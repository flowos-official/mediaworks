/**
 * Orchestrator — drives the Stage 1 pipeline end-to-end with bounded-agent
 * iteration: if curation yields < MIN_QUALITY candidates, re-asks Gemini for
 * additional keywords and re-curates (max MAX_ITERATIONS).
 * Ref: spec §4.2 단계 6.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { curatePool } from "./curate";
import { applyExclusions, loadExclusionContext } from "./exclusion";
import { buildCategoryPlan, loadRecentPlannedKeywords, loadTopCategories } from "./plan";
import { buildPool } from "./pool";
import type {
	Candidate,
	CategoryPlan,
	Context,
	LearningState,
	PoolItem,
} from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const MAX_ITERATIONS = Number(process.env.DISCOVERY_MAX_ITERATIONS ?? 3);
const MIN_QUALITY_COUNT = 20; // threshold: need 20+ score>=60 to skip iteration
const QUALITY_SCORE_THRESHOLD = 60;

export interface OrchestrateResult {
	candidates: Candidate[];
	plan: CategoryPlan;
	poolSize: number;
	iterations: number;
}

/**
 * Ask Gemini for additional fallback keywords if quality is insufficient.
 */
async function suggestMoreKeywords(
	currentPlan: CategoryPlan,
	qualityCount: number,
): Promise<string[]> {
	const prompt = `日本のテレビ通販向け商品発掘。現在のキーワードプランで品質基準(score>=60)を満たす候補が${qualityCount}件しかありません（目標20件以上）。

追加で3個のキーワードを提案してください。
- 短い汎用語（2〜5語）
- 楽天市場で検索可能
- 既存キーワードと異なる角度

既存キーワード: ${[...currentPlan.tv_proven, ...currentPlan.exploration].join(", ")}

【出力 — JSONのみ】
{ "keywords": ["キーワード1", "キーワード2", "キーワード3"] }`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) return [];
		const parsed = JSON.parse(match[0]) as { keywords?: string[] };
		return (parsed.keywords ?? []).slice(0, 3);
	} catch (err) {
		console.warn(
			"[orchestrator] suggestMoreKeywords failed:",
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

/**
 * Fetch additional pool for extra keywords (tagged as tv_proven since origin is curation-driven).
 */
async function buildAdditionalPool(keywords: string[]): Promise<PoolItem[]> {
	if (keywords.length === 0) return [];
	const partialPlan: CategoryPlan = {
		tv_proven: keywords,
		exploration: [],
	};
	return buildPool(partialPlan);
}

/**
 * Merge a pool extension into the main pool, deduping by productUrl.
 */
function mergePools(base: PoolItem[], extension: PoolItem[]): PoolItem[] {
	const seen = new Set(base.map((p) => p.productUrl));
	const merged = [...base];
	for (const item of extension) {
		if (seen.has(item.productUrl)) continue;
		seen.add(item.productUrl);
		merged.push(item);
	}
	return merged;
}

/**
 * Run the full Stage 1 orchestration: plan → pool → filter → curate, with
 * bounded-agent iteration on insufficient quality.
 * Caller provides learning state (loaded upstream).
 * Does NOT save to DB — caller handles persistence.
 */
export async function runStage1(
	learning: LearningState,
	targetCount: number,
	context: Context = "home_shopping",
): Promise<OrchestrateResult> {
	// Step 1: plan
	const [topCategories, recentlyUsed] = await Promise.all([
		loadTopCategories(),
		loadRecentPlannedKeywords(),
	]);
	const plan = await buildCategoryPlan(learning, topCategories, recentlyUsed, context);

	// Step 2: initial pool + exclusion
	let pool = await buildPool(plan);
	const exclusionCtx = await loadExclusionContext(learning);
	let filtered = applyExclusions(pool, exclusionCtx);

	// Step 3: curate with bounded iteration
	let candidates = await curatePool(filtered, targetCount, learning, context);
	let iterations = 0;
	let qualityCount = candidates.filter(
		(c) => c.tvFitScore >= QUALITY_SCORE_THRESHOLD,
	).length;

	while (qualityCount < MIN_QUALITY_COUNT && iterations < MAX_ITERATIONS) {
		iterations += 1;
		const extraKeywords = await suggestMoreKeywords(plan, qualityCount);
		if (extraKeywords.length === 0) break;

		const extension = await buildAdditionalPool(extraKeywords);
		pool = mergePools(pool, extension);
		filtered = applyExclusions(pool, exclusionCtx);
		candidates = await curatePool(filtered, targetCount, learning, context);
		qualityCount = candidates.filter(
			(c) => c.tvFitScore >= QUALITY_SCORE_THRESHOLD,
		).length;
	}

	return {
		candidates,
		plan,
		poolSize: pool.length,
		iterations,
	};
}
