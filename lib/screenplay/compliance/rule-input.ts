// Pure validation/normalization for compliance_rules create/update payloads.
// No server-only / Next imports so it can be unit-tested directly via tsx.

import type { ComplianceLaw, Severity } from "./types";

export const LAWS: ComplianceLaw[] = ["yakkiho", "keihyo", "kenzo", "shokuhin", "tokushoho"];
export const SEVS: Severity[] = ["high", "med", "low"];

export interface RuleInput {
	law?: string;
	category_scope?: unknown;
	pattern?: string;
	is_regex?: boolean;
	allowed?: boolean;
	severity?: string;
	reason?: string;
	safe_rewrite?: string;
	citation?: string;
	active?: boolean;
}

export type NormalizeResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: string };

/** Max length for a regex pattern (literal patterns may be longer). */
export const MAX_REGEX_LENGTH = 200;

/**
 * Heuristic guard against catastrophic-backtracking (ReDoS) regexes. The lexicon
 * matcher runs admin-entered regexes synchronously over screenplay text via
 * `new RegExp(p,"gu")` + matchAll, so a pattern like `(a+)+$` can hang the
 * deterministic compliance pass. We reject the dominant catastrophic shape:
 * an unbounded quantifier (`* + {n,}`) applied to a group that itself contains
 * an unbounded quantifier — i.e. star height > 1.
 *
 * This is a heuristic, not a proof: it does NOT catch overlap-alternation ReDoS
 * like `(a|a)*`. It eliminates the common nested-quantifier case while keeping
 * ordinary admin regexes (`No\.?1`, `(株式|有限)会社`) valid. Callers should
 * still treat the regex feature as admin-only.
 */
/**
 * Validate a pattern intended to run as a regex. Returns an error string, or
 * null when safe. Shared by create/update normalization and the PATCH route's
 * effective-value revalidation (toggling is_regex on a stored pattern).
 */
export function validateRegexPattern(pattern: string): string | null {
	try { new RegExp(pattern, "gu"); }
	catch { return "invalid regular expression"; }
	if (pattern.length > MAX_REGEX_LENGTH) return "regex too long";
	if (isUnsafeRegex(pattern)) return "unsafe regex (nested unbounded quantifier — possible ReDoS)";
	return null;
}

export function isUnsafeRegex(pattern: string): boolean {
	// stack[i] = does the currently-open group at depth i contain an unbounded
	// quantifier somewhere inside it?
	const stack: boolean[] = [];

	function isUnboundedAt(idx: number): boolean {
		const c = pattern[idx];
		if (c === "*" || c === "+") return true;
		if (c === "{") {
			// {n,} or {n,m}: unbounded only when there is no upper bound → {n,}
			const m = pattern.slice(idx).match(/^\{\d*,\}/);
			return !!m;
		}
		return false;
	}

	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "\\") { i++; continue; }            // skip escaped char
		if (c === "[") {                               // skip char class
			i++;
			while (i < pattern.length && pattern[i] !== "]") {
				if (pattern[i] === "\\") i++;
				i++;
			}
			continue;
		}
		if (c === "(") { stack.push(false); continue; }
		if (c === ")") {
			const innerHadUnbounded = stack.pop() ?? false;
			const groupUnbounded = isUnboundedAt(i + 1);
			if (innerHadUnbounded && groupUnbounded) return true; // star height > 1
			// A quantified group propagates as an unbounded quantifier to its parent.
			if (groupUnbounded && stack.length) stack[stack.length - 1] = true;
			continue;
		}
		if (isUnboundedAt(i) && stack.length) stack[stack.length - 1] = true;
	}
	return false;
}

/**
 * Validate + normalize a create (partial=false) or update (partial=true) body.
 * In partial mode only the provided keys are emitted. Regex validation here only
 * runs when both is_regex and pattern are present in the SAME body; the PATCH
 * route revalidates against the effective (stored-merged) values.
 */
export function normalizeRule(input: unknown, partial = false): NormalizeResult {
	const body: RuleInput = (input && typeof input === "object" ? input : {}) as RuleInput;
	const out: Record<string, unknown> = {};

	if (body.law !== undefined || !partial) {
		if (!LAWS.includes(body.law as ComplianceLaw)) return { ok: false, error: "invalid law" };
		out.law = body.law;
	}
	if (body.pattern !== undefined || !partial) {
		const p = (body.pattern ?? "").trim();
		if (!p) return { ok: false, error: "pattern is required" };
		if (p.length > 500) return { ok: false, error: "pattern too long" };
		out.pattern = p;
	}
	if (body.is_regex !== undefined || !partial) out.is_regex = !!body.is_regex;

	if (body.is_regex && typeof out.pattern === "string") {
		const err = validateRegexPattern(out.pattern as string);
		if (err) return { ok: false, error: err };
	}
	if (body.category_scope !== undefined || !partial) {
		const raw = body.category_scope;
		let arr: string[];
		if (Array.isArray(raw)) arr = raw.map((x) => String(x).trim()).filter(Boolean);
		else if (typeof raw === "string") arr = raw.split(",").map((s) => s.trim()).filter(Boolean);
		else arr = [];
		out.category_scope = arr;
	}
	if (body.allowed !== undefined || !partial) out.allowed = !!body.allowed;
	if (body.severity !== undefined || !partial) {
		const s = body.severity ?? "med";
		if (!SEVS.includes(s as Severity)) return { ok: false, error: "invalid severity" };
		out.severity = s;
	}
	if (body.reason !== undefined || !partial) out.reason = (body.reason ?? "").slice(0, 1000);
	if (body.safe_rewrite !== undefined || !partial) out.safe_rewrite = (body.safe_rewrite ?? "").slice(0, 1000);
	if (body.citation !== undefined || !partial) out.citation = (body.citation ?? "").slice(0, 300);
	if (body.active !== undefined) out.active = !!body.active;
	else if (!partial) out.active = true;

	return { ok: true, value: out };
}
