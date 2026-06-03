export type ComplianceLaw = "yakkiho" | "keihyo" | "kenzo";
export type Severity = "high" | "med" | "low";

export interface ComplianceRule {
	id: string;
	law: ComplianceLaw;
	category_scope: string[]; // empty = all categories
	pattern: string;
	is_regex: boolean;
	allowed: boolean;         // true = whitelist phrase; suppresses a flag
	severity: Severity;
	reason: string;
	safe_rewrite: string;
	citation: string;
	active: boolean;
}

export type FindingAxis = "legal" | "facts" | "quality";

export interface Finding {
	axis: FindingAxis;
	severity: Severity;
	quote: string;           // the offending text from the script
	reason: string;
	citedRule: string;       // law/citation (legal) or "" otherwise
	suggestedRewrite: string;
	source: "lexicon" | "llm";
}

export interface ScriptCheckResult {
	overallScore: number;    // 0..100
	legal: Finding[];
	facts: Finding[];
	quality: Finding[];
}
