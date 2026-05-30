/**
 * Gemini name-classifier for tv_channel discovery candidates.
 *
 * Why: most TV-shopping channel product pages expose NO structured category
 * (only ktvolm-shaped JSON-LD does). tv-channel-enrich recovers price/thumbnail
 * but leaves category NULL for the majority. This classifies a product NAME into
 * the operator-facing UI category labels.
 *
 * Taxonomy note: we classify directly into the CATEGORY_MAPPING keys (the same
 * labels the MD strategy panel offers). pool-query's buildCategoryMatchTerms
 * keys on those labels, and `r.category` is substring-matched — so storing the
 * label (e.g. "美容・スキンケア") is matched by a 美容・スキンケア request without any
 * separate channel-whitelist → sales-taxonomy bridge. Modeled on
 * lib/broadcasts/shopch-category.ts. Pure (no server-only) → tsx-importable for
 * the backfill script.
 *
 * Fail-open: any error → all null (row keeps NULL category, no worse than today).
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import { CATEGORY_MAPPING } from "@/lib/strategy/category-mapping";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
const LABELS = Object.keys(CATEGORY_MAPPING);
const VALID = new Set<string>(LABELS);

export interface ClassifyItem {
	name: string;
	description?: string | null;
}

interface GeminiResult {
	results?: Array<{ index: number; category: string | null }>;
}

/**
 * Batch-classify product names into operator UI category labels. Returns one
 * label-or-null per input item (same order). Single Gemini call. For large sets
 * (backfill) chunk the input before calling.
 */
export async function classifyProductCategories(
	items: ClassifyItem[],
): Promise<(string | null)[]> {
	if (items.length === 0) return [];

	const block = items
		.map(
			(it, i) =>
				`[${i}] ${it.name}${it.description ? `\n    ${it.description.slice(0, 150)}` : ""}`,
		)
		.join("\n\n");

	const prompt = `日本のテレビ通販商品を以下のカテゴリのいずれか1つに分類してください。明確に該当するものが無い/不明な場合は null を返してください（無理に分類しない）。

【カテゴリ一覧 — このうち1つを一字一句正確にコピー】
- ${LABELS.join("\n- ")}

【商品一覧】
${block}

【出力 — JSONのみ、前置き/後書きなし】
{
  "results": [
    {"index": 0, "category": "美容・スキンケア"},
    {"index": 1, "category": null}
  ]
}`;

	try {
		const model = genAI.getGenerativeModel({ model: GEMINI_FLASH });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) throw new Error("no JSON in classification response");
		const parsed = JSON.parse(match[0]) as GeminiResult;
		const byIndex = new Map<number, string | null>();
		for (const r of parsed.results ?? []) {
			byIndex.set(
				r.index,
				typeof r.category === "string" && VALID.has(r.category) ? r.category : null,
			);
		}
		return items.map((_, i) => byIndex.get(i) ?? null);
	} catch (err) {
		console.warn(
			"[tv-channel-category] classify failed (all null):",
			err instanceof Error ? err.message : String(err),
		);
		return items.map(() => null);
	}
}
