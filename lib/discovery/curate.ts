/**
 * Gemini-driven curation — selects top N from pool with scored breakdown.
 * Ref: spec §4.2 단계 5.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { modelForStage } from "@/lib/gemini-models";
import type {
	Candidate,
	Context,
	CurationScore,
	LearningState,
	PoolItem,
} from "./types";
import { deriveTvChannelSource } from "./tv-channels";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = modelForStage("discovery_curation");
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

	// Honesty layer for TV channel candidates: append the actual basis for any
	// popularity inference so Gemini doesn't have to guess.
	let popularityNote = "";
	if (p.rakutenCrossMatch) {
		const m = p.rakutenCrossMatch;
		popularityNote = ` | 楽天同等品マッチ:★${m.reviewAvg?.toFixed(1) ?? "?"}(${m.reviewCount ?? 0}件) ¥${m.priceJpy}`;
	} else if (p.tvChannel || (p.tvChannelMatches && p.tvChannelMatches.length > 0)) {
		popularityNote = ` | TV局公式(データ限定:レビュー非公開)`;
	}

	return `${i}: ${name} | ${price} | ${review} | ${seller} | seed=${p.seedKeyword} | track=${p.track}${popularityNote}`;
}

interface CurationFields {
	tvFitScore: number;
	tvFitReason: string;
	isTvApplicable: boolean;
	isLiveApplicable: boolean;
	scoreBreakdown: CurationScore;
	context: Context;
}

function poolItemToCandidate(
	source: PoolItem,
	fields: CurationFields,
): Candidate {
	return {
		...source,
		context: fields.context,
		tvFitScore: Math.max(0, Math.min(100, fields.tvFitScore)),
		tvFitReason: fields.tvFitReason,
		isTvApplicable: fields.isTvApplicable,
		isLiveApplicable: fields.isLiveApplicable,
		scoreBreakdown: fields.scoreBreakdown,
		tvChannelSource: deriveTvChannelSource(source),
	};
}

/**
 * Curate a pool into N candidates via Gemini.
 *
 * Single unified call with a source-neutral scoring rubric: items without
 * published review data (typical of TV-channel official-store pages) are
 * not penalized — they're scored on intrinsic product merit (category fit,
 * price fit, demo potential, trend signal). This replaced an earlier
 * approach that forced a 70/30 TV-vs-rakuten ratio per call — mechanical
 * quotas didn't reflect actual product quality. The pool ordering (TV-
 * tagged items round-robin-interleaved into the upstream pool builder)
 * still guarantees TV candidates reach the sample window; from there it's
 * a free-merit selection.
 *
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
【Context: ライブコマース (20-40代女性、SNS/動画ネイティブ、クリエイター追従層)】
- 重視: ビジュアル/動画映え、クリエイター親和性、SNS拡散性、インパルス価格帯フィット、リアルタイム購買トリガー (限定/タイムセール)
- 価格帯ゾーン: ¥1,000-8,000 (即決インパルス) / ファッションのみ ¥1,000-12,000
- カテゴリ重み (TikTok Shop JP実績):
  ★★★ 美容・パーソナルケア / 食品・ドリンク
  ★★  レディースファッション / おもちゃ・ホビー
  ★   生活トレンド雑貨
- 除外特性: 設置必須家電、高額耐久財、医薬品、TV実演必須商品、高齢者専用商品、機能訴求のみで視覚要素が弱い商品`
			: `
【Context: ホームショッピング (40代以上、TV視聴者 — 40-60代コア + 60代以上シニア層を含む)】
- 重視: 実演適性、ギフト需要、信頼感、TVデモ可能性、シニア層の使いやすさ・安心感
- 価格帯ゾーン: ¥3,000-30,000 (衝動買い)
- 除外特性: 若年層向けトレンド商品、SNS専用商品`;

	const requestCount = Math.ceil(targetCount * OVERSAMPLE_MULTIPLIER);

	const prompt = `あなたは日本のテレビ通販・ライブコマースに適した商品を選ぶバイヤーです。
以下の商品プールから上位${requestCount}個を選び、各商品を評価してください。
${contextBlock}

【プール出典について — 重要】
プールには楽天/Amazon 由来の商品と、TV放送局公式オンラインショップ (japanet/shop.ntv.co.jp/dinos/ropping/kachimo 等) 由来の商品が混在している。
TV放送局公式サイト由来の商品はレビュー数/評価を公開していない (★?, 0件)。これは「データ欠落」であって「品質低」ではない。各候補の末尾に出典に応じたメタ情報を付与している:
- "楽天同等品マッチ:★X.X(N件) ¥Y" — 同じ商品が楽天にも出品されており、その楽天レビューが popularity proxy として使える。TV局価格と楽天価格のレンジも確認可能。
- "TV局公式(データ限定:レビュー非公開)" — クロスマッチも見つからなかった商品。放送局が選定済みという事実のみが品質シグナル。score を控えめに (review_signal=5付近のニュートラル)。

【スコアリング指針 — 出典別】
- 楽天本体プール: 自前レビューを使用
- TV局 + 楽天マッチあり: 楽天マッチのレビューを使用 (TV局選定済みボーナスも実質含まれる)
- TV局 + マッチなし: review_signal は 5 ニュートラル (データ限定を honest に反映、決して 9 や 12 を与えないこと)。TVカテゴリ一致 / 実演適合性 / トレンドなどの forward-looking シグナルで競わせる。

【多様性ルール — 厳守】
同じ seed_keyword (pool に "seed=..." で記載) から選ぶのは最大 ${PER_SEED_CAP}個まで。
例: "包丁 セット" seed の高評価商品が5件あっても、選ぶのは3件まで。残り枠は他の seed から埋める。
目的: 単一カテゴリに偏らず、TV通販の商品バリエーションを確保する。

【採点基準 (合計0-100) — ソース中立】
- review_signal (0-15): 公開レビューがある場合のみ評価。レビュー無しは0ではなく7のニュートラル値 (情報無し=減点ではない)。
  * ★4.5以上 × 100件以上 → 14-15
  * ★4.5以上 × 50-99件 → 11-13
  * ★4.0-4.4 × 50件以上 → 9-11
  * ★3.5-3.9 → 5-8
  * ★3.0-3.4 → 3-5
  * ★3.0未満 (具体的に低評価) → 0-2
  * ★? / 0件 / レビュー非公開 → **7 (ニュートラル — TV放送局公式サイトでは通常)**
- tv_category_match (0-30): Context実績カテゴリとの一致 (一致=30, 隣接=15, 不一致=0) — 最重要シグナル
- trend_signal (0-15): 日本市場のトレンド信号の強さ。季節性シグナル適用可。
- price_fit (0-20): Context別価格帯ゾーンに近いほど高い (TVデモ衝動買い帯=20, 隣接=10, 外れ=0)
- purchase_signal (0-20): Context別の購買トリガー (実演映え or SNS拡散性) — 商品名/カテゴリから推定

【スコアリング哲学 — 厳守】
- forward-looking シグナル (tv_category_match + price_fit + purchase_signal = 70点) を主軸に、過去データ (review_signal + trend_signal = 30点) は補助。
- レビュー欠落で機械的に減点しない。商品の TV/EC 適性そのもので競わせる。
- 結果のソース分布 (楽天:TV) は質次第で自然に決まる。${seasonalHint}

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
        "review_signal": <0-15>,
        "tv_category_match": <0-30>,
        "trend_signal": <0-15>,
        "price_fit": <0-20>,
        "purchase_signal": <0-20>,
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
		candidates.push(
			poolItemToCandidate(source, {
				tvFitScore: c.tv_fit_score,
				tvFitReason: c.tv_fit_reason,
				isTvApplicable: c.is_tv_applicable,
				isLiveApplicable: c.is_live_applicable,
				scoreBreakdown: c.score_breakdown,
				context,
			}),
		);
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

export const __test = {
	poolItemToCandidate,
};
