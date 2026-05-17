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

export const __test = {
	parseGeminiResponse,
	validateAgainstWhitelist,
};
