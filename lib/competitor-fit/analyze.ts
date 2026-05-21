/**
 * Phase #10: competitor-product fit analysis.
 *
 * Given a slot from another home-shopping channel (QVC, ShopCh, OA, …),
 * use Gemini to estimate whether *our* TV-shopping operation could sell
 * the same/similar product, and if so, *when* and *how*.
 *
 * Goal expressed by JP business team:
 *   "Other channels are airing X right now. Could we sell X? If yes,
 *    when (next month / next year / off-season), through which channel,
 *    with which differentiation, and what are the risks?"
 *
 * Output is a small JSON object the UI renders inline beneath the slot.
 */

import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { GEMINI_MODELS_WITH_FALLBACK } from "@/lib/gemini-models";

let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
	if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	return _genAI;
}

const GEMINI_MODELS = GEMINI_MODELS_WITH_FALLBACK;

export interface CompetitorSlotInput {
	channel: string;          // e.g. "qvc", "shopch", "japanet"
	productName: string;
	category: string | null;
	priceText: string | null; // raw display text — keeps unit ambiguity
	airDate: string;          // YYYY-MM-DD JST
	startTime: string | null; // HH:MM:SS or null
	description: string | null;
	sourceUrl: string | null;
}

export interface CompetitorFitAnalysis {
	fitScore: number;                   // 0..100, our ability to sell this
	summary: string;                    // <=120 chars JA, one line
	recommendedTiming: string;          // e.g. "2026年12月～2027年2月（冬ピーク）"
	recommendedChannel: "tv" | "ec" | "live" | "tv+ec" | "skip";
	differentiation: string[];          // 2-4 bullet points
	risks: string[];                    // 2-3 bullet points
	confidence: "low" | "medium" | "high";
}

function isRetryable(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message;
	return (
		m.includes("503") ||
		m.includes("429") ||
		m.includes("500") ||
		m.includes("502") ||
		m.includes("504") ||
		m.includes("overloaded") ||
		m.includes("UNAVAILABLE") ||
		m.includes("timeout") ||
		m.includes("aborted") ||
		m.includes("ECONNRESET") ||
		m.includes("ETIMEDOUT")
	);
}

function isUnavailable(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message;
	return m.includes("404") || m.includes("Not Found") || m.includes("no longer available");
}

async function callOnce(model: string, prompt: string): Promise<string> {
	const HARD = 90_000;
	const FIRST = 45_000;
	const controller = new AbortController();
	const hard = setTimeout(
		() => controller.abort(new Error(`Gemini hard timeout ${HARD}ms`)),
		HARD,
	);
	let first: ReturnType<typeof setTimeout> | null = setTimeout(
		() => controller.abort(new Error(`Gemini first-chunk timeout ${FIRST}ms`)),
		FIRST,
	);
	const thinkingLevel = model.includes("pro") ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL;
	try {
		const stream = await getGenAI().models.generateContentStream({
			model,
			contents: prompt,
			config: {
				thinkingConfig: { thinkingLevel },
				abortSignal: controller.signal,
			},
		});
		let text = "";
		for await (const chunk of stream) {
			if (first) { clearTimeout(first); first = null; }
			text += chunk.text ?? "";
		}
		return text.trim();
	} finally {
		clearTimeout(hard);
		if (first) clearTimeout(first);
	}
}

async function callGemini(prompt: string): Promise<string> {
	let lastErr: unknown = null;
	for (const model of GEMINI_MODELS) {
		let modelDead = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await callOnce(model, prompt);
			} catch (err) {
				lastErr = err;
				if (isUnavailable(err)) { modelDead = true; break; }
				if (!isRetryable(err)) throw err;
				await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
			}
		}
		if (!modelDead) {
			console.warn(`[competitor-fit] model ${model} exhausted retries`);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error("All Gemini models failed");
}

function parseJSON<T>(raw: string): T {
	let cleaned = raw.trim();
	const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fence) cleaned = fence[1].trim();
	try {
		return JSON.parse(cleaned) as T;
	} catch { /* fall through */ }
	const start = cleaned.indexOf("{");
	if (start === -1) throw new Error("No JSON object found");
	let depth = 0;
	let inStr = false;
	let esc = false;
	let end = -1;
	for (let i = start; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (esc) { esc = false; continue; }
		if (ch === "\\") { esc = true; continue; }
		if (ch === '"') { inStr = !inStr; continue; }
		if (inStr) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end === -1) throw new Error("Unbalanced JSON");
	return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

function buildPrompt(slot: CompetitorSlotInput): string {
	return `あなたは日本のテレビ通販事業のMD (Merchandising Director) です。
他局の番組枠で放送中の商品について、「自社で同種商品を販売できるか、もし販売するならいつ・どう売るか」を分析してください。

【他局放送スロット】
- 放送局: ${slot.channel}
- 放送日: ${slot.airDate}${slot.startTime ? ` ${slot.startTime.slice(0, 5)}` : ""}
- 商品名: ${slot.productName}
- カテゴリ: ${slot.category ?? "(不明)"}
- 価格表示: ${slot.priceText ?? "(不明)"}
- 補足: ${slot.description ?? "(なし)"}
${slot.sourceUrl ? `- ソース: ${slot.sourceUrl}` : ""}

【自社の前提】
- 主要販路: TV通販 + EC、たまにライブコマース
- ターゲット: 40-60代コア + 60代以上シニア層 (実演映え・信頼性・ギフト需要を重視)
- 強み: 実演デモ、口頭説明の信頼感、シニア層リーチ
- 弱み: 若年層リーチ、SNS拡散、即時購入インパルス

【分析タスク】
1. 自社販売適合度 (0-100): 同種・類似商品を自社で売る場合の総合適合度
   - 80+: 即時企画推奨
   - 60-79: 条件付きで企画可（差別化要）
   - 40-59: 慎重判断
   - 40未満: 不向き（理由を明示）
2. 推奨販売時期: 「いつ売ると最も売れるか」を季節性・トレンド・他局放送タイミングを考慮して提案
   - 当日や直近1週間は「他局放送と被るため避ける」と判断してよい
   - 例: "2026年12月-2027年2月 (冬ピーク + 他局放送から半年離す)"
3. 推奨チャネル: "tv" / "ec" / "live" / "tv+ec" / "skip" のいずれか
4. 差別化ポイント: 他局と同じ商品では勝てないので、価格・セット内容・実演角度・付加サービスなど 2-4 点
5. リスク: 在庫・規制・季節性・需要減衰など 2-3 点
6. 確信度: "low" / "medium" / "high" — 情報量と判断難易度から

【出力形式 — 厳守。純粋なJSONのみ、markdown装飾なし】
{
  "fitScore": 0-100の整数,
  "summary": "120文字以内の日本語サマリ",
  "recommendedTiming": "日本語の時期 + 理由",
  "recommendedChannel": "tv"|"ec"|"live"|"tv+ec"|"skip",
  "differentiation": ["差別化ポイント1", "差別化ポイント2", "..."],
  "risks": ["リスク1", "リスク2", "..."],
  "confidence": "low"|"medium"|"high"
}`;
}

function validate(raw: unknown): CompetitorFitAnalysis {
	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid analysis shape");
	}
	const r = raw as Partial<Record<string, unknown>>;
	const fitScore = Number(r.fitScore);
	if (!Number.isFinite(fitScore) || fitScore < 0 || fitScore > 100) {
		throw new Error("fitScore out of range");
	}
	const channel = String(r.recommendedChannel ?? "");
	const validChannels: CompetitorFitAnalysis["recommendedChannel"][] = [
		"tv", "ec", "live", "tv+ec", "skip",
	];
	if (!validChannels.includes(channel as CompetitorFitAnalysis["recommendedChannel"])) {
		throw new Error("recommendedChannel invalid");
	}
	const confidence = String(r.confidence ?? "");
	const validConf: CompetitorFitAnalysis["confidence"][] = ["low", "medium", "high"];
	if (!validConf.includes(confidence as CompetitorFitAnalysis["confidence"])) {
		throw new Error("confidence invalid");
	}
	return {
		fitScore: Math.round(fitScore),
		summary: String(r.summary ?? "").slice(0, 240),
		recommendedTiming: String(r.recommendedTiming ?? ""),
		recommendedChannel: channel as CompetitorFitAnalysis["recommendedChannel"],
		differentiation: Array.isArray(r.differentiation)
			? r.differentiation.map((s) => String(s)).filter(Boolean).slice(0, 4)
			: [],
		risks: Array.isArray(r.risks)
			? r.risks.map((s) => String(s)).filter(Boolean).slice(0, 3)
			: [],
		confidence: confidence as CompetitorFitAnalysis["confidence"],
	};
}

export async function analyzeCompetitorFit(
	slot: CompetitorSlotInput,
): Promise<CompetitorFitAnalysis> {
	const prompt = buildPrompt(slot);
	const raw = await callGemini(prompt);
	const parsed = parseJSON<unknown>(raw);
	return validate(parsed);
}
