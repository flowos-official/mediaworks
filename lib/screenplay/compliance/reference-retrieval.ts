import type { ComplianceReference } from "./types";

/**
 * Structured (no-embedding) retrieval. Filters references to the product
 * category (empty scope = all), scores each by the count of its keywords that
 * occur as substrings in the script text, and returns the top-K (score > 0).
 * Japanese is not whitespace-tokenised, so we use substring occurrence, not
 * token overlap. Stable: ties broken by topic ascending → deterministic.
 */
export function selectReferences(
	scriptText: string,
	category: string | null,
	refs: ComplianceReference[],
	k = 8,
): ComplianceReference[] {
	const inScope = refs.filter(
		(r) =>
			r.active &&
			(r.category_scope.length === 0 ||
				(category !== null && r.category_scope.includes(category))),
	);
	const scored = inScope.map((r) => {
		const score = r.keywords.reduce(
			(s, kw) => s + (kw && scriptText.includes(kw) ? 1 : 0),
			0,
		);
		return { r, score };
	});
	scored.sort((a, b) => b.score - a.score || a.r.topic.localeCompare(b.r.topic, "ja"));
	return scored.filter((x) => x.score > 0).slice(0, k).map((x) => x.r);
}
