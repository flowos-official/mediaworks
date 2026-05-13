/**
 * Generate a 30-second TV home-shopping broadcast script draft (Japanese).
 * Separate Gemini call so the enrichment agent doesn't waste tool-call budget.
 *
 * Routed through Vercel AI Gateway (AI SDK v6) — see
 * docs/superpowers/specs/2026-05-13-skill-agent-registry-design.md
 */

import { generateText, gateway } from "ai";

// Gateway slug (different from Google SDK ID). Verify in AI Gateway dashboard.
const MODEL_ID = "google/gemini-3-flash";

export interface TvScriptInput {
	productName: string;
	priceJpy: number | null;
	reviewCount: number | null;
	reviewAvg: number | null;
	tvFitReason: string | null;
}

export async function generateTvScriptDraft(input: TvScriptInput): Promise<string> {
	const prompt = `日本のテレビ通販向け30秒放送スクリプトを作成してください。

【商品情報】
- 商品名: ${input.productName}
${input.priceJpy ? `- 価格: ¥${input.priceJpy.toLocaleString()}` : ""}
${input.reviewAvg ? `- 楽天レビュー: ★${input.reviewAvg} (${input.reviewCount ?? 0}件)` : ""}
${input.tvFitReason ? `- TV適合性: ${input.tvFitReason}` : ""}

【スクリプト構成 (30秒目安)】
1. フック (0-5秒): 視聴者の課題・ペインに直接訴える問いかけ
2. 商品提示 (5-15秒): 商品名と主要ベネフィット、実演ポイント
3. 社会的証拠 (15-20秒): レビュー数・評価
4. オファー (20-28秒): 価格と限定性（「今なら」「限定○名様」等）
5. コール (28-30秒): 注文アクション喚起

【出力】
スクリプト本文のみ（日本語）、番号付きセクション形式で300字以内。`;

	try {
		const { text } = await generateText({
			model: gateway(MODEL_ID),
			prompt,
			providerOptions: {
				gateway: {
					tags: ["skill:generate_tv_script_draft", "agent:discovery"],
				},
			},
			experimental_telemetry: {
				isEnabled: true,
				metadata: { skillSlug: "generate_tv_script_draft" },
			},
		});
		return text.trim();
	} catch (err) {
		console.warn(
			"[tvScript] generation failed:",
			err instanceof Error ? err.message : String(err),
		);
		return "(スクリプト生成失敗)";
	}
}
