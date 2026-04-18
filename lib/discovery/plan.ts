/**
 * Category planning — builds 15 keywords (tv_proven + exploration) for daily discovery.
 * Ref: spec §4.2 단계 2.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServiceClient } from "@/lib/supabase";
import type { CategoryPlan, Context, LearningState } from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const TOTAL_KEYWORDS = 15;

const FALLBACK_EXPLORATION = [
	"人気商品",
	"売れ筋",
	"おすすめ",
	"トレンド",
	"2026 新商品",
	"話題",
	"ランキング",
];

/**
 * Aggregate top TV-proven categories from product_summaries by total_revenue.
 */
export async function loadTopCategories(limit = 20): Promise<string[]> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("product_summaries")
		.select("category, total_revenue")
		.not("category", "is", null)
		.limit(10000);

	if (error) {
		console.warn("[plan] loadTopCategories failed:", error.message);
		return [];
	}

	const agg = new Map<string, number>();
	for (const row of (data ?? []) as Array<{
		category: string;
		total_revenue: number | null;
	}>) {
		agg.set(row.category, (agg.get(row.category) ?? 0) + (row.total_revenue ?? 0));
	}
	return [...agg.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([cat]) => cat);
}

/**
 * Load keywords used in the past N days so the planner can down-rank them.
 */
export async function loadRecentPlannedKeywords(
	days = 7,
): Promise<Set<string>> {
	const sb = getServiceClient();
	const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
	const { data, error } = await sb
		.from("discovery_runs")
		.select("category_plan")
		.gte("run_at", since);

	if (error) {
		console.warn("[plan] loadRecentPlannedKeywords failed:", error.message);
		return new Set();
	}

	const used = new Set<string>();
	for (const row of (data ?? []) as Array<{ category_plan: CategoryPlan | null }>) {
		if (!row.category_plan) continue;
		for (const kw of [
			...(row.category_plan.tv_proven ?? []),
			...(row.category_plan.exploration ?? []),
		]) {
			used.add(kw);
		}
	}
	return used;
}

/**
 * Build today's category plan via Gemini. Respects learning state ratio and
 * rejection hints. Falls back to deterministic defaults if Gemini fails.
 */
export async function buildCategoryPlan(
	learning: LearningState,
	topCategories: string[],
	recentlyUsed: Set<string>,
	context: Context = "home_shopping",
): Promise<CategoryPlan> {
	const explorationCount = Math.max(
		3,
		Math.min(10, Math.round(TOTAL_KEYWORDS * learning.exploration_ratio)),
	);
	const tvCount = TOTAL_KEYWORDS - explorationCount;

	const weightsHint = Object.entries(learning.category_weights)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([k, v]) => `${k}=${v.toFixed(2)}`)
		.join(", ");

	const rejectionHint = learning.recent_rejection_reasons
		.slice(0, 3)
		.map((r) => `${r.reason}(${r.count}件)`)
		.join(", ");

	const contextGuidance =
		context === "live_commerce"
			? `
【Context: ライブコマース】
- ターゲット: 20-40代、SNS利用者、即決購入層
- カテゴリ優先: 化粧品 / ファッション小物 / 美容家電 / ガジェット / 季節限定品 / トレンド雑貨
- 価格帯: ¥1,000-15,000 (即購入可能)
- 重視: SNS拡散性、ビジュアル、若年層共感、トレンド感`
			: `
【Context: ホームショッピング】
- ターゲット: 40-60代、TV視聴者、じっくり検討層
- カテゴリ優先: 美容家電 / キッチン調理器具 / 健康機器 / 寝具 / 防災 / 実演映え家電
- 価格帯: ¥3,000-30,000 (衝動買いゾーン)
- 重視: 実演適性、ギフト需要、信頼感、TVデモ可能性`;

	const prompt = `あなたは日本のテレビ通販・ライブコマース向け商品ソーシング専門家です。
今日の発掘キーワード${TOTAL_KEYWORDS}個を選んでください。
${contextGuidance}

【キーワード生成ルール — 厳守】
- 各キーワードは楽天市場で検索可能な短い汎用語（2〜5語）
- 具体的なブランド名や型番は含めない
- 修飾語は最小限
- 長い造語を避け、消費者が実際に検索する語を優先

【条件】
- tv_proven: ${tvCount}個 — 以下のTV実績カテゴリから選択。学習重みが高いカテゴリを優先。
- exploration: ${explorationCount}個 — TV実績にない新興/トレンドカテゴリ。日本市場で伸びている領域。

【TV実績カテゴリ (上位)】
${topCategories.join(", ") || "(データなし — 一般TV通販カテゴリから推定)"}

【カテゴリ学習重み (0.0-1.0, 高いほど優先)】
${weightsHint || "(コールドスタート中 — 均等)"}

【最近使用済みキーワード (下位優先)】
${[...recentlyUsed].join(", ") || "(なし)"}

【最近の主な却下理由 (減点対象特性)】
${rejectionHint || "(データ不足)"}

【出力 — JSONのみ、前置き/後書きなし】
{
  "tv_proven": ["キーワード1", "..."],
  "exploration": ["キーワード1", "..."],
  "reasoning": "1行説明（日本語）"
}`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) throw new Error("no JSON in plan response");
		const parsed = JSON.parse(match[0]) as Partial<CategoryPlan>;

		const plan: CategoryPlan = {
			tv_proven: (parsed.tv_proven ?? []).slice(0, tvCount),
			exploration: (parsed.exploration ?? []).slice(0, explorationCount),
			reasoning: parsed.reasoning,
		};

		if (plan.tv_proven.length === 0) {
			plan.tv_proven = topCategories.slice(0, tvCount);
		}
		if (plan.exploration.length === 0) {
			plan.exploration = FALLBACK_EXPLORATION.slice(0, explorationCount);
		}
		return plan;
	} catch (err) {
		console.warn(
			"[plan] Gemini planning failed, using fallback:",
			err instanceof Error ? err.message : String(err),
		);
		return {
			tv_proven: topCategories.slice(0, tvCount),
			exploration: FALLBACK_EXPLORATION.slice(0, explorationCount),
			reasoning: "fallback (Gemini failed)",
		};
	}
}
