/**
 * Gemini-driven curation — selects top N from pool with scored breakdown.
 * Ref: spec §4.2 단계 5.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
	Candidate,
	Context,
	CurationScore,
	LearningState,
	PoolItem,
} from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const POOL_SAMPLE_LIMIT = 150;
// Max candidates kept per seed keyword — prevents a single hot seed from
// monopolizing the final list while still allowing overflow backfill when
// diversity-first selection leaves a shortfall.
const PER_SEED_CAP = Number(process.env.DISCOVERY_PER_SEED_CAP ?? 3);
// Ask Gemini for extra candidates beyond targetCount so the diversity cap
// has overflow room without dropping below the target.
const OVERSAMPLE_MULTIPLIER = 1.5;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SEASONAL_HOT_THRESHOLD = 1.15;
const SEASONAL_COLD_THRESHOLD = 0.85;

function currentJstMonth(): number {
	return new Date(Date.now() + JST_OFFSET_MS).getUTCMonth() + 1;
}

function buildSeasonalCurationHint(
	seasonal: Record<string, Record<string, number>>,
	month: number,
): string {
	const key = String(month);
	const hot: string[] = [];
	const cold: string[] = [];
	for (const [cat, months] of Object.entries(seasonal)) {
		const f = months[key];
		if (typeof f !== "number") continue;
		if (f >= SEASONAL_HOT_THRESHOLD) hot.push(`${cat}(×${f.toFixed(2)})`);
		else if (f <= SEASONAL_COLD_THRESHOLD) cold.push(`${cat}(×${f.toFixed(2)})`);
	}
	if (hot.length === 0 && cold.length === 0) return "";
	return `
【${month}月の季節性シグナル (trend_signal採点に反映)】
- 旬カテゴリ (加点): ${hot.slice(0, 8).join(", ") || "(該当なし)"}
- 閑散カテゴリ (減点): ${cold.slice(0, 6).join(", ") || "(該当なし)"}`;
}

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
	context: Context = "home_shopping",
): Promise<Candidate[]> {
	if (pool.length === 0) return [];

	const sampled = pool.slice(0, POOL_SAMPLE_LIMIT);
	const poolList = sampled.map((p, i) => formatPoolLine(p, i)).join("\n");

	const rejectionHints =
		learning.recent_rejection_reasons
			.slice(0, 3)
			.map((r) => `${r.reason}(${r.count}件)`)
			.join(", ") || "(データ不足)";

	const seasonalHint = buildSeasonalCurationHint(
		learning.category_seasonal_weights ?? {},
		currentJstMonth(),
	);

	const contextBlock =
		context === "live_commerce"
			? `
【Context: ライブコマース (20-40代、SNS利用者)】
- 重視: SNS拡散性、ビジュアル訴求、トレンド感、若年層共感
- 価格帯ゾーン: ¥1,000-15,000 (即購入)
- 除外特性: じっくり検討が必要な高額品、高齢者専用商品`
			: `
【Context: ホームショッピング (40-60代、TV視聴者)】
- 重視: 実演適性、ギフト需要、信頼感、TVデモ可能性
- 価格帯ゾーン: ¥3,000-30,000 (衝動買い)
- 除外特性: 若年層向けトレンド商品、SNS専用商品`;

	const requestCount = Math.ceil(targetCount * OVERSAMPLE_MULTIPLIER);

	const prompt = `あなたは日本のテレビ通販・ライブコマースに適した商品を選ぶバイヤーです。
以下の商品プールから上位${requestCount}個を選び、各商品を評価してください。
${contextBlock}

【多様性ルール — 厳守】
同じ seed_keyword (pool に "seed=..." で記載) から選ぶのは最大 ${PER_SEED_CAP}個まで。
例: "包丁 セット" seed の高評価商品が5件あっても、選ぶのは3件まで。残り枠は他の seed から埋める。
目的: 単一カテゴリに偏らず、TV通販の商品バリエーションを確保する。

【採点基準 (合計0-100)】
- review_signal (0-35): レビュー評価と数の総合強度。評価(★)を最優先、件数は補強。
  * ★4.5以上 × 100件以上 → 30-35 (強い社会的証明)
  * ★4.5以上 × 50-99件 → 24-29
  * ★4.0-4.4 × 100件以上 → 22-28
  * ★4.0-4.4 × 50-99件 → 16-22
  * ★3.5-3.9 × 件数問わず → 8-14 (件数が多くても中評価は中止まり)
  * ★3.0-3.4 × 件数問わず → 3-8 (低評価は件数多くても減点)
  * ★3.0未満 → 0-3 (件数多くてもキャップ、どれだけ売れていても品質懸念)
  * ★? または 5件未満 → 0-5 (データ不足)
- tv_category_match (0-20): Context実績カテゴリとの一致 (一致=20, 隣接=10, 不一致=0)
- trend_signal (0-15): 日本市場のトレンド信号の強さ。季節性シグナル適用可。
- price_fit (0-15): Context別価格帯ゾーンに近いほど高い
- purchase_signal (0-15): Context別の購買トリガー (実演映え or SNS拡散性)
${seasonalHint}

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
			context,
			tvFitScore: Math.max(0, Math.min(100, c.tv_fit_score)),
			tvFitReason: c.tv_fit_reason,
			isTvApplicable: c.is_tv_applicable,
			isLiveApplicable: c.is_live_applicable,
			scoreBreakdown: c.score_breakdown,
		});
	}

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);

	// Strictly enforce seed diversity: max PER_SEED_CAP per seedKeyword, stop
	// when we hit targetCount. Gemini is already instructed to respect the
	// cap upstream; this acts as a hard safety net. If fewer than targetCount
	// candidates survive the cap, the orchestrator's quality-iteration loop
	// will request additional keywords (rather than duplicating hot seeds).
	const seedCounts = new Map<string, number>();
	const result: Candidate[] = [];
	for (const c of candidates) {
		if (result.length >= targetCount) break;
		const n = seedCounts.get(c.seedKeyword) ?? 0;
		if (n >= PER_SEED_CAP) continue;
		result.push(c);
		seedCounts.set(c.seedKeyword, n + 1);
	}
	return result;
}
