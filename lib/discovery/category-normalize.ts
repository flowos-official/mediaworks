/**
 * Discovery category normalization — Rakuten-genre → whitelist mapping.
 * Spec: docs/superpowers/specs/2026-05-17-discovery-category-normalize-design.md
 *
 * Caches results in discovered_category_normalization (PK: raw_category).
 * Gemini Flash classifies cache misses against the channel_categories
 * whitelist. Manual rows are protected from automatic re-classification.
 */

interface GeminiResultItem {
	index: number;
	matches: string[];
}

/**
 * Parse a Gemini response into typed items. Tolerates markdown fences,
 * extra whitespace, and surrounding text. Returns [] on any parse failure;
 * caller handles fail-open behavior.
 */
export function parseGeminiResponse(text: string): GeminiResultItem[] {
	if (!text) return [];
	const match = text.match(/\{[\s\S]+\}/);
	if (!match) return [];
	try {
		const obj = JSON.parse(match[0]) as { results?: unknown };
		if (!Array.isArray(obj.results)) return [];
		const out: GeminiResultItem[] = [];
		for (const r of obj.results) {
			if (typeof r !== "object" || r === null) continue;
			const rec = r as Record<string, unknown>;
			if (typeof rec.index !== "number" || !Number.isInteger(rec.index)) continue;
			if (!Array.isArray(rec.matches)) continue;
			const matches = rec.matches.filter((m): m is string => typeof m === "string");
			out.push({ index: rec.index, matches });
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Drop hallucinated categories (not in whitelist) and deduplicate.
 * Preserves input order of first occurrence.
 */
export function validateAgainstWhitelist(
	matches: string[],
	whitelist: Set<string>,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of matches) {
		if (!whitelist.has(m)) continue;
		if (seen.has(m)) continue;
		seen.add(m);
		out.push(m);
	}
	return out;
}

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { SupabaseClient } from "@supabase/supabase-js";

const MODEL_ID = "gemini-3-flash-preview";
export const BATCH_SIZE = 50;

let _genAI: GoogleGenerativeAI | null = null;
function genAI(): GoogleGenerativeAI {
	if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
	return _genAI;
}

export async function loadWhitelist(sb: SupabaseClient): Promise<string[]> {
	const { data, error } = await sb
		.from("channel_categories")
		.select("category")
		.eq("is_allowed", true);
	if (error || !data) {
		console.warn(`[category-normalize] whitelist load failed: ${error?.message ?? "no data"}`);
		return [];
	}
	const seen = new Set<string>();
	for (const row of data as Array<{ category: string }>) {
		if (row.category) seen.add(row.category);
	}
	return [...seen].sort();
}

export function buildPrompt(whitelist: string[], inputs: string[]): string {
	const inputBlock = inputs.map((s, i) => `[${i}] ${s}`).join("\n");
	return `日本の家庭用通販商品のカテゴリ文字列を、以下のホワイトリストに分類してください。
複数該当する場合は最大3つ、該当無しは空配列を返してください。
ホワイトリストにない文字列は絶対に出力しないでください。

【ホワイトリスト — このうちから正確にコピー】
- ${whitelist.join("\n- ")}

【入力】
${inputBlock}

【出力 — JSONのみ、前置き/後書きなし】
{ "results": [
  {"index": 0, "matches": ["家電"]},
  {"index": 1, "matches": []}
]}`;
}

export async function classifyBatchViaGemini(
	whitelist: string[],
	inputs: string[],
): Promise<Map<string, string[]>> {
	if (inputs.length === 0 || whitelist.length === 0) return new Map();
	const prompt = buildPrompt(whitelist, inputs);
	const whitelistSet = new Set(whitelist);
	try {
		const model = genAI().getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const parsed = parseGeminiResponse(text);
		const out = new Map<string, string[]>();
		for (const item of parsed) {
			if (item.index < 0 || item.index >= inputs.length) continue;
			const validated = validateAgainstWhitelist(item.matches, whitelistSet).slice(0, 3);
			out.set(inputs[item.index], validated);
		}
		return out;
	} catch (err) {
		console.warn(
			`[category-normalize] Gemini classification failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return new Map();
	}
}

export const __test = {
	parseGeminiResponse,
	validateAgainstWhitelist,
	loadWhitelist,
	buildPrompt,
	classifyBatchViaGemini,
	BATCH_SIZE,
};
