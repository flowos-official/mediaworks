/**
 * Phase 1-C: Gemini-based ShopCh slot classifier.
 *
 * Why: ShopCh slot HTML has no per-slot category attribute, and slots have
 * no product IDs (unlike QVC's Phase B PoC). We classify based on the
 * `program_title + description` text against the 5-item whitelist in one
 * batched Gemini call per crawl run (~24 slots/day, ~1 API call).
 *
 * Fail-open: if the call errors, every slot gets category=null and is
 * filtered out downstream. Losing a day's ingest is preferable to
 * persisting unclassified noise.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ScrapedSlot } from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";

export const SHOPCH_WHITELIST = [
	"靴・バッグ・小物・インナー",
	"コスメ",
	"美容・ダイエット・フィットネス",
	"ホーム・インテリア",
	"家電",
] as const;
type ShopChCategory = (typeof SHOPCH_WHITELIST)[number];

const VALID = new Set<string>(SHOPCH_WHITELIST);

interface GeminiResult {
	results?: Array<{ index: number; category: string | null }>;
}

/**
 * Batch-classify ShopCh slots against the 5-item whitelist using a single
 * Gemini call. Returns a new array with `category` filled (or null for
 * "not in whitelist"). Mutates nothing.
 */
export async function classifyShopChSlots(
	slots: ScrapedSlot[],
): Promise<ScrapedSlot[]> {
	if (slots.length === 0) return slots;

	const block = slots
		.map(
			(s, i) =>
				`[${i}] title: ${s.program_title}\n    description: ${(s.description ?? "").slice(0, 200)}`,
		)
		.join("\n\n");

	const prompt = `日本のショップチャンネル放送スロットを以下のカテゴリのいずれか1つに分類してください。該当無しならnullを返してください。

【カテゴリ一覧 — このうち1つを正確にコピー】
- ${SHOPCH_WHITELIST.join("\n- ")}

【スロット一覧】
${block}

【出力 — JSONのみ、前置き/後書きなし】
{
  "results": [
    {"index": 0, "category": "コスメ"},
    {"index": 1, "category": null}
  ]
}`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) throw new Error("no JSON in classification response");
		const parsed = JSON.parse(match[0]) as GeminiResult;
		const byIndex = new Map<number, ShopChCategory | null>();
		for (const r of parsed.results ?? []) {
			if (r.category === null) {
				byIndex.set(r.index, null);
				continue;
			}
			if (typeof r.category === "string" && VALID.has(r.category)) {
				byIndex.set(r.index, r.category as ShopChCategory);
			}
			// silently ignore hallucinated category values
		}
		return slots.map((s, i) => ({ ...s, category: byIndex.get(i) ?? null }));
	} catch (err) {
		console.warn(
			"[shopch-category] Gemini classification failed, all slots will drop:",
			err instanceof Error ? err.message : String(err),
		);
		return slots.map((s) => ({ ...s, category: null }));
	}
}
