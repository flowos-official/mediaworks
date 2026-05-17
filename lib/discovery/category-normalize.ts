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

// ---------------------------------------------------------------------------
// Public cache-aware API
// ---------------------------------------------------------------------------

interface CacheRow {
	raw_category: string;
	whitelist_categories: string[];
}

/**
 * Normalize a single raw category. Cache hit → immediate. Miss → Gemini
 * single-item classify (batch of 1) → upsert → return. Returns [] on
 * null/empty input or any failure (fail-open).
 *
 * Does NOT overwrite rows with source='manual'.
 */
export async function normalizeCategory(
	sb: SupabaseClient,
	rawCategory: string | null,
): Promise<string[]> {
	const raw = (rawCategory ?? "").trim();
	if (!raw) return [];

	const hit = await sb
		.from("discovered_category_normalization")
		.select("whitelist_categories")
		.eq("raw_category", raw)
		.maybeSingle();
	if (hit.data) return hit.data.whitelist_categories as string[];

	const whitelist = await loadWhitelist(sb);
	if (whitelist.length === 0) return [];

	const batch = await classifyBatchViaGemini(whitelist, [raw]);
	if (!batch.has(raw)) return []; // classification failed; do NOT cache

	const matches = batch.get(raw)!;
	await sb
		.from("discovered_category_normalization")
		.upsert(
			{ raw_category: raw, whitelist_categories: matches, source: "gemini" },
			{ onConflict: "raw_category", ignoreDuplicates: false },
		);
	return matches;
}

/**
 * Batch version for cron / backfill. Dedups input, fetches cached hits
 * in one IN(...) query, classifies misses in chunks of BATCH_SIZE, upserts,
 * returns a Map for every distinct input (empty array for failed
 * classifications — but those entries are NOT cached so the next call
 * will retry).
 */
export async function normalizeCategoriesBatch(
	sb: SupabaseClient,
	rawCategories: string[],
): Promise<Map<string, string[]>> {
	const deduped = [...new Set(rawCategories.map((s) => s.trim()).filter(Boolean))];
	if (deduped.length === 0) return new Map();

	const result = new Map<string, string[]>();
	for (const raw of deduped) result.set(raw, []);

	const hits = await sb
		.from("discovered_category_normalization")
		.select("raw_category, whitelist_categories")
		.in("raw_category", deduped);
	if (hits.data) {
		for (const row of hits.data as CacheRow[]) {
			result.set(row.raw_category, row.whitelist_categories);
		}
	}

	const cachedSet = new Set((hits.data ?? []).map((h: CacheRow) => h.raw_category));
	const misses = deduped.filter((r) => !cachedSet.has(r));
	if (misses.length === 0) return result;

	const whitelist = await loadWhitelist(sb);
	if (whitelist.length === 0) return result;

	for (let i = 0; i < misses.length; i += BATCH_SIZE) {
		const chunk = misses.slice(i, i + BATCH_SIZE);
		const classified = await classifyBatchViaGemini(whitelist, chunk);
		const upserts: Array<{ raw_category: string; whitelist_categories: string[]; source: "gemini" }> = [];
		for (const raw of chunk) {
			if (!classified.has(raw)) continue;
			const matches = classified.get(raw)!;
			result.set(raw, matches);
			upserts.push({ raw_category: raw, whitelist_categories: matches, source: "gemini" });
		}
		if (upserts.length > 0) {
			const upd = await sb
				.from("discovered_category_normalization")
				.upsert(upserts, { onConflict: "raw_category", ignoreDuplicates: false });
			if (upd.error) {
				console.warn(`[category-normalize] batch upsert failed: ${upd.error.message}`);
			}
		}
	}
	return result;
}
