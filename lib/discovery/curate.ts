/**
 * Gemini-driven curation — selects top N from pool with scored breakdown.
 * Ref: spec §4.2 단계 5.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
	Candidate,
	CurationScore,
	LearningState,
	PoolItem,
} from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const POOL_SAMPLE_LIMIT = 150;

interface GeminiCurationItem {
	index: number;
	tv_fit_score: number;
	tv_fit_reason: string;
	is_tv_applicable: boolean;
	is_live_applicable: boolean;
	score_breakdown: CurationScore;
}

function formatPoolLine(p: PoolItem, i: number): string {
	const price = p.priceJpy ? `¥${p.priceJpy}` : "¥?";
	const review = `★${p.reviewAvg ?? "?"}(${p.reviewCount ?? 0})`;
	const seller = p.sellerName ?? "?";
	const name = p.name.slice(0, 80);
	return `${i}: ${name} | ${price} | ${review} | ${seller} | seed=${p.seedKeyword} | track=${p.track}`;
}

/**
 * Curate a pool into N candidates via Gemini.
 * Returns candidates sorted by tvFitScore DESC.
 */
export async function curatePool(
	pool: PoolItem[],
	targetCount: number,
	learning: LearningState,
): Promise<Candidate[]> {
	if (pool.length === 0) return [];

	const sampled = pool.slice(0, POOL_SAMPLE_LIMIT);
	const poolList = sampled.map((p, i) => formatPoolLine(p, i)).join("\n");

	const rejectionHints =
		learning.recent_rejection_reasons
			.slice(0, 3)
			.map((r) => `${r.reason}(${r.count}件)`)
			.join(", ") || "(データ不足)";

	const prompt = `あなたは日本のテレビ通販・ライブコマースに適した商品を選ぶバイヤーです。
以下の商品プールから上位${targetCount}個を選び、各商品を評価してください。

【採点基準 (合計0-100)】
- review_signal (0-35): Rakutenレビュー数と評価の強さ (≥100件→30+, 50-99→20, 5-49→10, <5→0)
- tv_category_match (0-20): TV実績カテゴリとの一致 (一致=20, 隣接=10, 不一致=0)
- trend_signal (0-15): 日本市場のトレンド信号の強さ
- price_fit (0-15): ¥3,000-30,000 衝動買いゾーンに近いほど高い
- purchase_signal (0-15): 実演映え・ギフト需要・SNS拡散性

【除外すべき特性 (採点せず応答から除外)】
- 単価¥500未満の消耗品
- 専門設置が必要な高額家電 (デモ不可)
- 医薬品・処方箋必要
- 資格・許認可が必要な販売カテゴリ

【最近の却下理由 (減点対象)】
${rejectionHints}

【商品プール — index: name | price | review | seller | seed | track】
${poolList}

【tv_fit_reason 作成ルール】
- 商品の実際の特性（カテゴリ、レビュー数、価格帯、実演映えなど）を根拠に説明
- seed_keyword（検索に使ったキーワード）は参照しないこと
- 商品名から推定される機能・ベネフィットに焦点

【出力 — JSONのみ、前置き/後書き・コメントなし】
{
  "candidates": [
    {
      "index": <プールのインデックス>,
      "tv_fit_score": <0-100>,
      "tv_fit_reason": "1行 (日本語, 50字以内, 商品特性のみ)",
      "is_tv_applicable": true,
      "is_live_applicable": true,
      "score_breakdown": {
        "review_signal": <0-35>,
        "tv_category_match": <0-20>,
        "trend_signal": <0-15>,
        "price_fit": <0-15>,
        "purchase_signal": <0-15>,
        "total": <合計>
      }
    }
  ]
}`;

	const model = genAI.getGenerativeModel({ model: MODEL_ID });
	const res = await model.generateContent(prompt);
	const text = res.response.text();
	const match = text.match(/\{[\s\S]+\}/);
	if (!match) throw new Error("curate: no JSON in response");

	const parsed = JSON.parse(match[0]) as { candidates?: GeminiCurationItem[] };
	const items = parsed.candidates ?? [];

	const candidates: Candidate[] = [];
	for (const c of items) {
		const source = sampled[c.index];
		if (!source) continue;
		candidates.push({
			...source,
			tvFitScore: Math.max(0, Math.min(100, c.tv_fit_score)),
			tvFitReason: c.tv_fit_reason,
			isTvApplicable: c.is_tv_applicable,
			isLiveApplicable: c.is_live_applicable,
			scoreBreakdown: c.score_breakdown,
		});
	}

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return candidates.slice(0, targetCount);
}
