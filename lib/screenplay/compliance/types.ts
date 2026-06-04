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
	source: "lexicon" | "llm" | "corpus";
	references?: FindingSource[];
}

export interface ScriptCheckResult {
	overallScore: number;    // 0..100
	legal: Finding[];
	facts: Finding[];
	quality: Finding[];
	grounding?: GroundingMeta;
}

export type ReferenceLaw = ComplianceLaw | "other";

export interface ComplianceReference {
	id: string;
	law: ReferenceLaw;
	category_scope: string[]; // empty = all categories
	topic: string;
	body: string;
	keywords: string[];
	citation: string;
	source_url: string;
	active: boolean;
}

export interface FindingSource {
	title: string;
	url: string;
}

export interface GroundingMeta {
	referenceIds: string[];   // compliance_references.id injected into this judgment
	corpusHash: string;       // sha256 over selected refs (id:body), short
	factSearch: boolean;      // whether live web search ran
	searchDomains: string[];  // hostnames hit by fact search (egress observability)
}
