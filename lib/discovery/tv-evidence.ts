/**
 * TV Evidence Mining — deterministic per-candidate broadcast history.
 * Spec: docs/superpowers/specs/2026-05-17-tv-evidence-mining-design.md
 */

/**
 * Split a Japanese composite category into atomic keywords (≥2 chars).
 * Mirrors the pattern in lib/discovery/competitor-trend-boost.ts so the
 * two modules behave identically on shared inputs.
 */
export function splitCategoryToKeywords(category: string): string[] {
	if (!category) return [];
	return category
		.split(/[・\/／,、]/)
		.map((s) => s.trim().normalize("NFKC"))
		.filter((s) => s.length >= 2);
}

/**
 * Tokenize a product name into substrings suitable for ILIKE matching:
 * - Split on whitespace and a small set of punctuation
 * - Drop tokens shorter than 3 characters (catches noise like "x", "ml")
 *   — Japanese tokens of length 2 are kept as a special case via the
 *   length-3 filter only when string is ASCII; full-width chars count
 *   as 1 codepoint each, so 3-char Japanese tokens still survive.
 *   For simplicity, all tokens use the same ≥3 codepoint rule. Short
 *   Japanese names like "セラム" (3 chars) qualify; "30ml" (4) qualifies;
 *   "a" or "b" (1 char) does not.
 * - Keep at most 3 tokens to bound query cost.
 */
export function tokenizeName(name: string): string[] {
	if (!name) return [];
	return name
		.normalize("NFKC")
		.split(/[\s・\/／,、|\-]+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 3)
		.slice(0, 3);
}

/**
 * Compute the q-th percentile of a numeric array using linear interpolation
 * between closest ranks. Returns 0 for empty input.
 *
 * Note: This is a simple definition; we don't need exact statistical
 * accuracy — the values feed a Gemini prompt where one yen of precision
 * is irrelevant.
 */
export function percentile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = (sorted.length - 1) * q;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const __test = {
	splitCategoryToKeywords,
	tokenizeName,
	percentile,
};
