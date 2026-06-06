import type { ComplianceRule, Finding } from "./types";

/** True if a rule applies to the given product category (empty scope = all). */
function inScope(rule: ComplianceRule, category: string | null): boolean {
	if (rule.category_scope.length === 0) return true;
	if (!category) return false; // scoped rule + unknown category → do not fire
	return rule.category_scope.includes(category);
}

export type Span = [start: number, end: number];

/** All match spans (start,end) of a rule's pattern within `text`. */
function findSpans(rule: ComplianceRule, text: string): Span[] {
	const spans: Span[] = [];
	if (rule.is_regex) {
		let re: RegExp;
		try {
			re = new RegExp(rule.pattern, "gu");
		} catch {
			return spans; // a malformed regex rule never throws the whole check
		}
		for (const m of text.matchAll(re)) {
			if (m.index === undefined) continue;
			if (m[0].length === 0) break; // guard against zero-width infinite loop
			spans.push([m.index, m.index + m[0].length]);
		}
		return spans;
	}
	let i = text.indexOf(rule.pattern);
	while (i !== -1) {
		spans.push([i, i + rule.pattern.length]);
		i = text.indexOf(rule.pattern, i + 1);
	}
	return spans;
}

/** True when `span` is wholly contained within one of the `outer` spans. */
export function within(span: Span, outer: Span[]): boolean {
	return outer.some(([s, e]) => span[0] >= s && span[1] <= e);
}

/**
 * Text spans of every active, in-scope, `allowed` (whitelist) rule's matches.
 * Shared by `matchLexicon` (to suppress flags inside an allowed phrase) and by
 * the Tier-1 remediation patcher (to avoid rewriting copy the lexicon
 * deliberately permits). Recompute on the current text when offsets may have
 * shifted.
 */
export function allowedSpansFor(
	text: string,
	rules: ComplianceRule[],
	category: string | null,
): Span[] {
	const spans: Span[] = [];
	for (const r of rules) {
		if (r.active && r.allowed && inScope(r, category)) spans.push(...findSpans(r, text));
	}
	return spans;
}

/**
 * Deterministic pass: flag every active, in-scope, non-`allowed` rule whose
 * pattern appears in the markdown. `allowed` rules are whitelist phrases —
 * suppress a flag ONLY for the specific occurrences that fall inside an allowed
 * phrase's text span. A non-allowed pattern that also appears standalone
 * (outside any allowed span) is still flagged. This is text-span containment,
 * NOT pattern-string containment — so a short NG pattern that happens to be a
 * substring of an allowed phrase is not blanket-suppressed everywhere.
 */
export function matchLexicon(
	markdown: string,
	rules: ComplianceRule[],
	category: string | null,
): Finding[] {
	const active = rules.filter((r) => r.active && inScope(r, category));

	const allowedSpans = allowedSpansFor(markdown, rules, category);

	const findings: Finding[] = [];
	for (const r of active) {
		if (r.allowed) continue;
		const spans = findSpans(r, markdown);
		if (spans.length === 0) continue;
		// Suppress only when EVERY occurrence sits inside an allowed span.
		if (spans.every((sp) => within(sp, allowedSpans))) continue;
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
