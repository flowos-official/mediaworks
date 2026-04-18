/**
 * Discovery pipeline types.
 * Ref: docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md §4
 */

export type Track = "tv_proven" | "exploration";
export type CandidateSource = "rakuten" | "brave" | "other";
export type BroadcastTag =
	| "broadcast_confirmed"
	| "broadcast_likely"
	| "unknown";
export type EnrichmentStatus =
	| "idle"
	| "queued"
	| "running"
	| "completed"
	| "failed";
export type UserAction =
	| "sourced"
	| "interested"
	| "rejected"
	| "duplicate";
export type SessionStatus =
	| "running"
	| "completed"
	| "partial"
	| "failed";

export interface CategoryPlan {
	tv_proven: string[];
	exploration: string[];
	reasoning?: string;
}

export interface PoolItem {
	name: string;
	productUrl: string;
	thumbnailUrl?: string;
	priceJpy?: number;
	reviewCount?: number;
	reviewAvg?: number;
	sellerName?: string;
	stockStatus?: string;
	source: CandidateSource;
	rakutenItemCode?: string;
	seedKeyword: string;
	track: Track;
}

export interface CurationScore {
	review_signal: number;
	tv_category_match: number;
	trend_signal: number;
	price_fit: number;
	purchase_signal: number;
	total: number;
}

export interface Candidate extends PoolItem {
	tvFitScore: number;
	tvFitReason: string;
	isTvApplicable: boolean;
	isLiveApplicable: boolean;
	scoreBreakdown: CurationScore;
}

export interface RejectedSeeds {
	urls: string[];
	brands: string[];
	terms: string[];
}

export interface LearningState {
	exploration_ratio: number;
	category_weights: Record<string, number>;
	rejected_seeds: RejectedSeeds;
	recent_rejection_reasons: Array<{ reason: string; count: number }>;
	feedback_sample_size: number;
	is_cold_start: boolean;
}

export interface ExclusionContext {
	ownSourcedNames: string[];
	recentDiscoveredUrls: Set<string>;
	crossSessionRakutenCodes: Set<string>;
	rejectedUrls: Set<string>;
	rejectedBrands: Set<string>;
	rejectedTerms: string[];
}

export const DEFAULT_LEARNING_STATE: LearningState = {
	exploration_ratio: 0.47,
	category_weights: {},
	rejected_seeds: { urls: [], brands: [], terms: [] },
	recent_rejection_reasons: [],
	feedback_sample_size: 0,
	is_cold_start: true,
};

export type Confidence = "high" | "medium" | "low";

export interface ManufacturerInfo {
	name: string | null;
	is_seller_same_as_manufacturer: boolean;
	official_site: string | null;
	address: string | null;
	contact_hints: string[];
	confidence: Confidence;
}

export interface WholesaleEstimate {
	retail_jpy: number;
	estimated_cost_jpy: number | null;
	estimated_margin_rate: number | null;
	method: "baseline" | "blended" | "mediaworks_adjusted";
	sample_size: number;
	confidence: Confidence;
}

export interface SnsTrend {
	signal_strength: "high" | "medium" | "low" | "none";
	sources: string[];
}

export interface CPackage {
	manufacturer: ManufacturerInfo;
	wholesale_estimate: WholesaleEstimate;
	moq_hint: string | null;
	tv_script_draft: string;
	sns_trend: SnsTrend;
	enriched_at: string;
	tool_calls_used: number;
	partial: boolean;
	error?: string;
}
