export type EvidenceClass =
	| "verified"
	| "source_claim"
	| "proxy"
	| "inferred"
	| "internal_input";

export type EvidenceValueState =
	| "known"
	| "unknown"
	| "not_applicable"
	| "stale"
	| "conflicting";

export type KnowledgeMode = "stored_only" | "supplemented";

export type SubjectType = "product" | "broadcast" | "category" | "internal_product";

export interface EvidenceDraft {
	subjectType: SubjectType;
	subjectId: string;
	predicate: string;
	value?: unknown;
	unit?: string;
	valueState: EvidenceValueState;
	evidenceClass: EvidenceClass;
	sourceType: string;
	sourceTable: string;
	sourceRecordId: string;
	sourceUrl?: string;
	sourceLocator?: string;
	observedAt: string;
	validFrom?: string;
	validUntil?: string;
	confidence: number;
	rawHash?: string;
}

export interface EvidenceItem extends EvidenceDraft {
	id: string;
	dedupeKey: string;
	revokedAt?: string;
}

export interface KnowledgeSnapshotDraft {
	consumerType: "product_recommendation" | "research" | "screenplay";
	consumerRunId: string;
	createdBy: string | null;
	mode: KnowledgeMode;
	query: Record<string, unknown>;
	dataCutoff: string;
	algorithmVersion: string;
	modelVersion?: string;
	items: Array<{
		evidenceItemId?: string;
		insightSnapshotId?: string;
		usageRole: string;
		resultLocator?: string;
	}>;
}
