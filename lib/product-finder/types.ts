/** Widened from a literal to the ledger's own union when supplemental research
 *  landed (20260829160000). The POST parser stays pinned to "stored_only":
 *  reaching a provider is a separate, explicitly requested act, never something
 *  a query parameter can turn on. */
import type { KnowledgeMode } from "@/lib/intelligence/types";

/**
 * Contracts for the stored-only product finder.
 *
 * The shape here encodes the two rules the surface exists to keep:
 *
 * 1. An axis carries its own STATUS. A score of 0.4 that was measured and a
 *    score of 0.4 inferred from a competitor's claim are not the same fact, and
 *    collapsing them into one number is how a proxy becomes a truth. Rendering
 *    reads `status`, never just `normalized`.
 * 2. Profit stays null unless internal data supports it. `null` means unknown;
 *    0 would mean "we measured zero", which is a different and much stronger
 *    claim than anything a competitor's sales copy can support.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */

export type AxisStatus = "measured" | "proxy" | "unknown";

export type AxisKey =
	| "market_demand"
	| "company_fit"
	| "profitability"
	| "competition_headroom"
	| "broadcast_fit";

export interface ScoreAxis {
	key: AxisKey;
	status: AxisStatus;
	/** null exactly when `status` is "unknown" — an unscored axis has no number. */
	normalized: number | null;
	label: string;
	evidenceIds: string[];
}

export interface ProductFinderQuery {
	category?: string;
	targetCustomer?: string;
	priceMinJpy?: number;
	priceMaxJpy?: number;
	targetMarginRate?: number;
	desiredFeatures: string[];
	excludedTerms: string[];
	limit: number;
	mode: KnowledgeMode;
}

export interface ProductFinderItem {
	id: string;
	canonicalProductId: string;
	rank: number;
	name: string;
	category: string | null;
	opportunityIndex: number;
	/** null = unknown. Never 0 as a stand-in for absent internal cost data. */
	expectedContributionProfitJpy: number | null;
	axes: ScoreAxis[];
	confidence: { level: "high" | "medium" | "low"; coverage: number };
	reasons: string[];
	risks: string[];
	missingData: string[];
}

export interface ProductFinderResult {
	runId: string;
	mode: KnowledgeMode;
	generatedAt: string;
	query: ProductFinderQuery;
	candidateCount: number;
	items: ProductFinderItem[];
}

export const AXIS_KEYS: readonly AxisKey[] = [
	"market_demand",
	"company_fit",
	"profitability",
	"competition_headroom",
	"broadcast_fit",
] as const;
