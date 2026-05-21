/**
 * Discovery pipeline types.
 * Ref: docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md §4
 */

export type Track = "tv_proven" | "exploration";
export type Context = "home_shopping" | "live_commerce";
export type CandidateSource = "rakuten" | "brave" | "tv_channel" | "other";
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
	category?: string;
	reviewCount?: number;
	reviewAvg?: number;
	sellerName?: string;
	stockStatus?: string;
	source: CandidateSource;
	rakutenItemCode?: string;
	seedKeyword: string;
	track: Track;
	context?: Context;
	/** Primary channel slug for a tv_channel-sourced PoolItem. */
	tvChannel?: string;
	/** All channel slugs that surfaced the same product (post-dedup merge). */
	tvChannelMatches?: string[];
	/**
	 * Rakuten cross-match for tv_channel items. The 13 non-broadcast TV
	 * channels publish no review/popularity data, so we surface the
	 * equivalent listing on Rakuten (when one exists) as a popularity proxy.
	 * Set only after `enrichTvChannelWithRakutenCrossMatch` runs.
	 */
	rakutenCrossMatch?: {
		itemUrl: string;
		itemName: string;
		reviewCount: number;
		reviewAvg: number;
		priceJpy: number;
		similarityScore: number;
	};
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
	context: Context;
	/** Comma-joined alphabetically-sorted channel slugs, or null. */
	tvChannelSource?: string | null;
}

export interface RejectedSeeds {
	urls: string[];
	brands: string[];
	terms: string[];
}

export interface LearningState {
	exploration_ratio: number;
	category_weights: Record<string, number>;
	/**
	 * Per-category monthly seasonality factor map.
	 * { "<category>": { "1".."12": factor } } where 1.0 = annual-average month.
	 * Empty object during cold-start; populated by daily-learning cron.
	 */
	category_seasonal_weights: Record<string, Record<string, number>>;
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
	feedbackSourcedUrls: Set<string>;
	feedbackSourcedCodes: Set<string>;
}

export const DEFAULT_LEARNING_STATE: LearningState = {
	exploration_ratio: 0.47,
	category_weights: {},
	category_seasonal_weights: {},
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

export interface TvEvidenceSample {
	channel: string;
	air_date: string; // YYYY-MM-DD
	title: string;
	price_jpy: number | null;
}

export interface TvEvidenceTimeslot {
	channel: "qvc" | "shopch";
	dow: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
	hour_bucket: number; // 0..23
	count: number;
}

export interface TvEvidencePriceStats {
	median: number;
	p25: number;
	p75: number;
	count: number;
}

export interface TvEvidenceMatchBasis {
	category_keywords: string[]; // empty if no category
	price_band: [number, number] | null;
	name_tokens: string[];
}

export interface TvEvidence {
	matched_at: string; // ISO timestamp
	match_basis: TvEvidenceMatchBasis;
	airing_count: number;
	recent_30d_count: number;
	recent_90d_count: number;
	channel_breakdown: Record<string, number>;
	price_jpy: TvEvidencePriceStats | null;
	top_timeslots: TvEvidenceTimeslot[];
	samples: TvEvidenceSample[];
	evidence_strength: number; // 0..1
}
