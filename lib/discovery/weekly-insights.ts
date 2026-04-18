/**
 * Weekly insights aggregation + Gemini natural-language summary.
 * Ref: Phase 6 spec.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServiceClient } from "@/lib/supabase";
import type { Context } from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";

export interface WeeklyInsightInput {
	weekStart: string;
	weekEnd: string;
	context: Context;
	sourcedCount: number;
	rejectedCount: number;
	interestedCount: number;
	topCategories: Array<{ category: string; sourced: number; shown: number }>;
	topRejectionReasons: Array<{ reason: string; count: number }>;
	explorationWinRate: number;
	tvProvenWinRate: number;
	currentExplorationRatio: number;
}

export interface WeeklyInsightOutput {
	sourced_product_patterns: string;
	exploration_wins: string;
	next_week_suggestions: string;
}

interface AggregateRow {
	category: string | null;
	track: "tv_proven" | "exploration";
	user_action: "sourced" | "interested" | "rejected" | "duplicate" | null;
	action_reason: string | null;
}

/**
 * Aggregate last week's feedback for a context.
 */
export async function aggregateWeek(
	context: Context,
	weekStart: Date,
	weekEnd: Date,
): Promise<WeeklyInsightInput> {
	const sb = getServiceClient();
	const from = weekStart.toISOString();
	const to = weekEnd.toISOString();

	const { data: products } = await sb
		.from("discovered_products")
		.select("category, track, user_action, action_reason")
		.eq("context", context)
		.gte("created_at", from)
		.lte("created_at", to);

	const items = (products ?? []) as AggregateRow[];
	const sourcedCount = items.filter((p) => p.user_action === "sourced").length;
	const rejectedCount = items.filter((p) => p.user_action === "rejected").length;
	const interestedCount = items.filter((p) => p.user_action === "interested").length;

	const catMap = new Map<string, { sourced: number; shown: number }>();
	for (const p of items) {
		const cat = p.category ?? "unknown";
		const stat = catMap.get(cat) ?? { sourced: 0, shown: 0 };
		stat.shown += 1;
		if (p.user_action === "sourced") stat.sourced += 1;
		catMap.set(cat, stat);
	}
	const topCategories = [...catMap.entries()]
		.map(([category, s]) => ({ category, ...s }))
		.sort((a, b) => b.sourced - a.sourced)
		.slice(0, 5);

	const reasonMap = new Map<string, number>();
	for (const p of items) {
		if (p.user_action === "rejected" && p.action_reason) {
			reasonMap.set(p.action_reason, (reasonMap.get(p.action_reason) ?? 0) + 1);
		}
	}
	const topRejectionReasons = [...reasonMap.entries()]
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);

	const tvRows = items.filter((p) => p.track === "tv_proven");
	const expRows = items.filter((p) => p.track === "exploration");
	const tvWins = tvRows.filter(
		(p) => p.user_action === "sourced" || p.user_action === "interested",
	).length;
	const expWins = expRows.filter(
		(p) => p.user_action === "sourced" || p.user_action === "interested",
	).length;

	const { data: state } = await sb
		.from("learning_state")
		.select("exploration_ratio")
		.eq("context", context)
		.single();

	return {
		weekStart: from,
		weekEnd: to,
		context,
		sourcedCount,
		rejectedCount,
		interestedCount,
		topCategories,
		topRejectionReasons,
		explorationWinRate: expRows.length > 0 ? expWins / expRows.length : 0,
		tvProvenWinRate: tvRows.length > 0 ? tvWins / tvRows.length : 0,
		currentExplorationRatio: Number(state?.exploration_ratio ?? 0.47),
	};
}

/**
 * Call Gemini for natural-language weekly summary.
 */
export async function generateWeeklyInsight(
	input: WeeklyInsightInput,
): Promise<WeeklyInsightOutput> {
	const contextLabel =
		input.context === "home_shopping" ? "ホームショッピング" : "ライブコマース";

	const prompt = `あなたは日本のテレビ通販・ライブコマース向け商品発掘システムのアナリストです。
以下の週間データを元に、日本語で週次インサイトをまとめてください。

【対象Context】 ${contextLabel}
【期間】 ${input.weekStart.slice(0, 10)} ~ ${input.weekEnd.slice(0, 10)}

【主要指標】
- ソーシング数: ${input.sourcedCount}
- 関心あり: ${input.interestedCount}
- 却下: ${input.rejectedCount}
- 現在の探索比率: ${(input.currentExplorationRatio * 100).toFixed(0)}%
- TV実績カテゴリの成功率: ${(input.tvProvenWinRate * 100).toFixed(1)}%
- 探索カテゴリの成功率: ${(input.explorationWinRate * 100).toFixed(1)}%

【カテゴリ別成果 (Top 5)】
${input.topCategories.map((c) => `- ${c.category}: ソーシング${c.sourced}/${c.shown}件`).join("\n") || "(データなし)"}

【却下理由 (Top 5)】
${input.topRejectionReasons.map((r) => `- ${r.reason}: ${r.count}件`).join("\n") || "(なし)"}

【出力 — JSONのみ、前置き/後書きなし】
{
  "sourced_product_patterns": "ソーシングされた商品の共通パターン + ハイライト (150字以内, 日本語)",
  "exploration_wins": "探索カテゴリで成功したケースの分析 (100字以内, 日本語)",
  "next_week_suggestions": "来週の戦略提案 (150字以内, 日本語, 具体的なカテゴリ名や比率提案含む)"
}`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) throw new Error("no JSON in response");
		const parsed = JSON.parse(match[0]) as WeeklyInsightOutput;
		return {
			sourced_product_patterns: parsed.sourced_product_patterns ?? "",
			exploration_wins: parsed.exploration_wins ?? "",
			next_week_suggestions: parsed.next_week_suggestions ?? "",
		};
	} catch (err) {
		console.warn(
			`[weekly-insights] Gemini failed for ${input.context}:`,
			err instanceof Error ? err.message : String(err),
		);
		return {
			sourced_product_patterns: "(生成失敗)",
			exploration_wins: "(生成失敗)",
			next_week_suggestions: "(生成失敗)",
		};
	}
}
