/**
 * The model half of claim grounding.
 *
 * It is given the numbered script and the fact pack and nothing else — no
 * search, no corpus, no competitor text. Its only job is to point each factual
 * statement at a fact key; what that key permits is decided in claim-links.ts,
 * which is why a confidently wrong status here cannot promote a proxy into an
 * on-air claim.
 *
 * `screenplay_grounding` is its own cost stage. A grounding pass runs once per
 * version and its size scales with the script, not with the draft's difficulty,
 * so folding it into screenplay_generation would blur the one number an
 * operator uses to decide whether a script is worth regenerating.
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { modelForStage } from "@/lib/gemini-models";
import { recordGeminiUsage, toUsageRecord } from "@/lib/gemini-usage";
import type { ClaimClassifier, ClaimClassifierOutput, ClaimStatus } from "./claim-links";

const TIMEOUT_MS = 90_000;
const MAX_LINES = 1_200;

const RESPONSE_SCHEMA = {
	type: "object",
	required: ["claims"],
	properties: {
		claims: {
			type: "array",
			items: {
				type: "object",
				required: ["lineStart", "lineEnd", "claimText", "status", "reason"],
				properties: {
					lineStart: { type: "number" },
					lineEnd: { type: "number" },
					claimText: { type: "string" },
					factKey: { type: "string" },
					status: { type: "string", enum: ["supported", "source_claim", "needs_review"] },
					reason: { type: "string" },
				},
			},
		},
	},
} as const;

const STATUSES = new Set<ClaimStatus>(["supported", "source_claim", "needs_review"]);

export function geminiClaimClassifier(subject?: string): ClaimClassifier {
	return async ({ numberedLines, facts }) => {
		const apiKey = process.env.GEMINI_API_KEY;
		if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
		const model = modelForStage("screenplay_grounding");

		const prompt = [
			"# タスク：台本の事実主張を、使用可能な事実に紐づける",
			"下の台本から、視聴者が事実として受け取る記述（数値・実績・効果・優位性・保証・価格）をすべて抜き出し、",
			"それぞれがどの事実キーに基づくかを判定せよ。",
			"",
			"## 判定",
			"- supported: 事実欄の値と一致し、断定してよい",
			"- source_claim: 事実欄にあるがメーカー申告であり、出典明示が必要",
			"- needs_review: 事実欄に根拠がない",
			"",
			"## 規則",
			"- factKey は下の事実欄に存在するキーのみ。存在しない場合は null とし status を needs_review にする。",
			"- 台本にない行番号を返さない。lineStart <= lineEnd。",
			"- 演出キュー・カメラ指示は事実主張ではない。",
			"",
			"## 使用可能な事実",
			facts.length > 0
				? facts
						.map((f) => `- ${f.key} (${f.label} / ${f.usage}): ${JSON.stringify(f.value)}${f.unit ? ` ${f.unit}` : ""}`)
						.join("\n")
				: "- （事実データなし。すべて needs_review になる）",
			"",
			"## 台本（行番号付き）",
			numberedLines.slice(0, MAX_LINES).map((l) => `${l.line}: ${l.text}`).join("\n"),
		].join("\n");

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Gemini timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
		try {
			const response = await new GoogleGenAI({ apiKey }).models.generateContent({
				model,
				contents: prompt,
				config: {
					responseMimeType: "application/json",
					responseSchema: RESPONSE_SCHEMA as never,
					thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
					abortSignal: controller.signal,
				},
			});
			await recordGeminiUsage(
				toUsageRecord({
					stage: "screenplay_grounding",
					model,
					usage: response.usageMetadata,
					succeeded: true,
					...(subject ? { subject } : {}),
				}),
			);
			const parsed = JSON.parse(response.text ?? "{}") as { claims?: unknown };
			const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
			return claims.flatMap((raw): ClaimClassifierOutput[] => {
				const c = raw as Record<string, unknown>;
				const status = String(c.status) as ClaimStatus;
				if (!STATUSES.has(status)) return [];
				const factKey = typeof c.factKey === "string" && c.factKey.trim() ? c.factKey.trim() : null;
				return [{
					lineStart: Number(c.lineStart),
					lineEnd: Number(c.lineEnd),
					claimText: String(c.claimText ?? ""),
					factKey,
					status,
					reason: String(c.reason ?? ""),
				}];
			});
		} catch (error) {
			await recordGeminiUsage(
				toUsageRecord({
					stage: "screenplay_grounding",
					model,
					usage: undefined,
					succeeded: false,
					errorCode: error instanceof Error ? error.name : "unknown",
					...(subject ? { subject } : {}),
				}),
			);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	};
}
