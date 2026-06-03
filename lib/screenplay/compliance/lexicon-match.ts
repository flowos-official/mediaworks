import type { ComplianceRule, Finding } from "./types";

/** True if a rule applies to the given product category (empty scope = all). */
function inScope(rule: ComplianceRule, category: string | null): boolean {
	if (rule.category_scope.length === 0) return true;
	if (!category) return false; // scoped rule + unknown category → do not fire
	return rule.category_scope.includes(category);
}

function matches(rule: ComplianceRule, text: string): boolean {
	if (rule.is_regex) {
		try {
			return new RegExp(rule.pattern, "u").test(text);
		} catch {
			return false; // a malformed regex rule never throws the whole check
		}
	}
	return text.includes(rule.pattern);
}

/**
 * Deterministic pass: flag every active, in-scope, non-`allowed` rule whose
 * pattern appears in the markdown. `allowed` rules are whitelist phrases — if
 * one matches, suppress any flag whose quote is contained within the allowed
 * match span (e.g. "小じわを目立たなくする" must not trip a "消える"-style rule).
 */
export function matchLexicon(
	markdown: string,
	rules: ComplianceRule[],
	category: string | null,
): Finding[] {
	const active = rules.filter((r) => r.active && inScope(r, category));
	const allowedHits = active
		.filter((r) => r.allowed && matches(r, markdown))
		.map((r) => r.pattern);

	const findings: Finding[] = [];
	for (const r of active) {
		if (r.allowed) continue;
		if (!matches(r, markdown)) continue;
		// Suppress when the offending pattern is wholly inside an allowed phrase.
		if (allowedHits.some((a) => a.includes(r.pattern))) continue;
		findings.push({
			axis: "legal",
			severity: r.severity,
			quote: r.pattern,
			reason: r.reason,
			citedRule: r.citation || r.law,
			suggestedRewrite: r.safe_rewrite,
			source: "lexicon",
		});
	}
	return findings;
}
