export interface MdStrategyEvidenceRow {
	id: string;
	user_goal: string | null;
	product_selection: unknown;
}

export interface MdStrategyEvidenceSummary {
	id: string;
	user_goal: string | null;
	internalProductCount: number;
	externalCandidateCount: number;
	poolSources: string[];
	poolSourceCounts: Array<{ source: string; count: number }>;
	discoveryPoolCount: number;
	freshSearchCount: number;
	researchCandidateCount: number;
	tvSignalCount: number;
	discoveredProductIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function countInternalMatrixProducts(productSelection: Record<string, unknown>): number {
	return asArray(productSelection.channel_product_matrix).reduce<number>((sum, channel) => {
		const row = asRecord(channel);
		return (
			sum +
			asArray(row.tier1_products).length +
			asArray(row.tier2_products).length
		);
	}, 0);
}

function countBySource(candidates: Array<Record<string, unknown>>, source: string): number {
	return candidates.filter((candidate) => candidateSource(candidate) === source).length;
}

function candidateSource(candidate: Record<string, unknown>): string {
	return text(candidate.pool_source) || text(candidate.source);
}

function hasTvSignal(candidate: Record<string, unknown>): boolean {
	if (text(candidate.source) === "tv_channel") return true;
	if (text(candidate.tv_channel_source)) return true;
	if (/[TＴ][VＶ]|OA|テレビ|通販/.test(text(candidate.signal_basis))) return true;
	const evidence = asRecord(candidate.tv_evidence);
	return Number(evidence.airing_count ?? 0) > 0;
}

export function summarizeMdStrategyEvidence(
	row: MdStrategyEvidenceRow,
): MdStrategyEvidenceSummary {
	const productSelection = asRecord(row.product_selection);
	const externalCandidates = asArray(productSelection.discovered_new_products).map(asRecord);
	const poolSources = unique(externalCandidates.map(candidateSource));
	return {
		id: row.id,
		user_goal: row.user_goal,
		internalProductCount: countInternalMatrixProducts(productSelection),
		externalCandidateCount: externalCandidates.length,
		poolSources,
		poolSourceCounts: poolSources.map((source) => ({
			source,
			count: countBySource(externalCandidates, source),
		})),
		discoveryPoolCount: countBySource(externalCandidates, "discovery_pool"),
		freshSearchCount: countBySource(externalCandidates, "fresh_search"),
		researchCandidateCount: countBySource(externalCandidates, "research"),
		tvSignalCount: externalCandidates.filter(hasTvSignal).length,
		discoveredProductIds: unique(
			externalCandidates.map((candidate) => text(candidate.discovered_product_id)),
		),
	};
}

export function hasIntegratedStrategyEvidence(
	summary: MdStrategyEvidenceSummary | null,
): summary is MdStrategyEvidenceSummary {
	return (
		!!summary &&
		summary.internalProductCount > 0 &&
		summary.externalCandidateCount > 0 &&
		summary.discoveredProductIds.length > 0
	);
}
