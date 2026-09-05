import { TV_CHANNELS } from "@/lib/discovery/tv-channels";
import type { EvidenceItem, EvidenceValueState } from "./types";

export interface InsightDraft {
	insightType: string;
	subjectType: "product" | "category";
	subjectId: string;
	inputFrom: string | null;
	inputUntil: string;
	result: Record<string, unknown>;
	evidenceIds: string[];
	coverage: Record<string, unknown>;
	formulaVersion: string;
	modelVersion?: string;
	confidence: number;
	validUntil?: string;
}

export const PRODUCT_MARKET_INSIGHT_TYPE = "product_market";
export const PRODUCT_MARKET_FORMULA_VERSION = "product-market-v1";
export const BROADCAST_CATEGORY_INSIGHT_TYPE = "broadcast_category_market";
export const BROADCAST_CATEGORY_FORMULA_VERSION = "broadcast-category-v1";

type CoverageState = EvidenceValueState | "absent";

export const PRODUCT_INSIGHT_PREDICATES = [
	"price_jpy",
	"airing_count_30d",
	"tv_airing_count",
	"review_count",
	"review_average",
	"review_avg",
	"ranking_position",
	"sales_rank",
	"seller_claim",
	"seller_claims",
	"product_claim",
	"product_claims",
	"selling_points",
	"gross_profit_jpy",
	"profit_per_unit_jpy",
	"gross_margin_pct",
	"actual_competitor_sales",
] as const;
const PRODUCT_PREDICATES = new Set<string>(PRODUCT_INSIGHT_PREDICATES);

export const CATEGORY_INSIGHT_PREDICATES = [
	"category",
	"normalized_category",
	"air_date",
	"duration_sec",
	"price_jpy",
	"segment_pattern",
	"selling_points",
	"evidence_cues",
	"objection_handlings",
	"offer_timing",
] as const;
const CATEGORY_PREDICATES = new Set<string>(CATEGORY_INSIGHT_PREDICATES);

const STRUCTURE_PREDICATES = new Set([
	"segment_pattern",
	"selling_points",
	"evidence_cues",
	"objection_handlings",
	"offer_timing",
]);

const SELLER_CLAIM_PREDICATES = new Set([
	"seller_claim",
	"seller_claims",
	"product_claim",
	"product_claims",
	"selling_points",
]);

/**
 * Predicates that carry OUR OWN margin, not a competitor's claim about theirs.
 *
 * Exported so a consumer derives the set rather than restating it. This project
 * has been bitten by hand-written copies drifting from their source (see the
 * tv-channels note in CLAUDE.md); here the cost of drift is a profitability
 * axis that silently stops seeing internal data and reports "unknown" forever.
 */
export const INTERNAL_PROFIT_PREDICATES = new Set([
	"gross_profit_jpy",
	"profit_per_unit_jpy",
	"gross_margin_pct",
]);

/**
 * Which `sourceType` values count as a broadcast channel.
 *
 * Derived from the discovery registry rather than restated — the literal this
 * replaces had fallen four channels behind (ropping, kachimo, kaidoki,
 * uranoura), so their evidence was skipped here and simply did not appear in
 * `categoryImbalance`.
 *
 * `"oa"` is included because `mapBroadcastAnalysisEvidence` falls back to it
 * when a broadcast row has no channel. Without it that evidence fell through
 * this filter and the insight reported `channels: []` with no dominant channel
 * — an empty answer that reads like "no channels aired this" rather than
 * "the channel was not recorded".
 */
const CHANNELS = new Set<string>([
	...TV_CHANNELS.map((channel) => channel.slug),
	"oa",
]);

function timestamp(value: string, label: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO date or timestamp`);
	return parsed;
}

function provenanceKey(item: EvidenceItem): string {
	return [
		item.subjectType,
		item.subjectId,
		item.predicate,
		item.sourceType,
		item.sourceTable,
		item.sourceRecordId,
		item.sourceLocator ?? "",
	].join("\u0000");
}

/**
 * Selection semantics for a cutoff:
 * 1. the observation and valid-from are at/before the cutoff;
 * 2. valid-until is absent or at/after the cutoff, and stale rows are excluded;
 * 3. for each subject/predicate/provenance locator, only the greatest
 *    observation timestamp is current (all rows tied at that timestamp remain).
 *
 * The schema has no revocation column, so none is consulted. Current unknown,
 * conflicting, and not-applicable rows remain available for coverage, but the
 * builders never coerce them to values.
 */
export function selectActiveEvidence(evidence: EvidenceItem[], cutoff: string): EvidenceItem[] {
	const cutoffMs = timestamp(cutoff, "cutoff");
	const eligible = evidence.filter((item) => {
		if (item.valueState === "stale") return false;
		const observedAt = timestamp(item.observedAt, `evidence ${item.id} observedAt`);
		if (observedAt > cutoffMs) return false;
		if (item.validFrom && timestamp(item.validFrom, `evidence ${item.id} validFrom`) > cutoffMs) return false;
		if (item.validUntil && timestamp(item.validUntil, `evidence ${item.id} validUntil`) < cutoffMs) return false;
		return true;
	});

	const latestByProvenance = new Map<string, number>();
	for (const item of eligible) {
		const key = provenanceKey(item);
		const observedAt = timestamp(item.observedAt, `evidence ${item.id} observedAt`);
		latestByProvenance.set(key, Math.max(latestByProvenance.get(key) ?? -Infinity, observedAt));
	}

	return eligible
		.filter((item) => timestamp(item.observedAt, `evidence ${item.id} observedAt`) === latestByProvenance.get(provenanceKey(item)))
		.sort((left, right) => left.id.localeCompare(right.id));
}

function known(item: EvidenceItem): boolean {
	return item.valueState === "known" && item.value !== undefined && item.value !== null;
}

function finiteValue(item: EvidenceItem): number | undefined {
	return known(item) && typeof item.value === "number" && Number.isFinite(item.value)
		? item.value
		: undefined;
}

function coverageState(items: EvidenceItem[]): CoverageState {
	if (items.length === 0) return "absent";
	if (items.some((item) => item.valueState === "conflicting")) return "conflicting";
	if (items.some(known)) return "known";
	if (items.some((item) => item.valueState === "unknown")) return "unknown";
	if (items.some((item) => item.valueState === "not_applicable")) return "not_applicable";
	return "absent";
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function distribution(values: number[]): { count: number; min: number; median: number; max: number } | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	return {
		count: sorted.length,
		min: sorted[0],
		median: median(sorted),
		max: sorted.at(-1)!,
	};
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function round(value: number, digits = 4): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function commonDraft(
	items: EvidenceItem[],
	cutoff: string,
): Pick<InsightDraft, "inputFrom" | "inputUntil" | "evidenceIds" | "validUntil"> {
	const observed = items.map((item) => item.observedAt).sort();
	const expirations = items
		.map((item) => item.validUntil)
		.filter((value): value is string => Boolean(value))
		.sort();
	return {
		inputFrom: observed[0] ?? null,
		inputUntil: new Date(timestamp(cutoff, "cutoff")).toISOString(),
		evidenceIds: [...new Set(items.map((item) => item.id))].sort(),
		...(expirations[0] ? { validUntil: expirations[0] } : {}),
	};
}

function confidence(items: EvidenceItem[], sectionCoverage: CoverageState[], sampleFactor = 1): number {
	if (items.length === 0) return 0;
	const averageEvidence = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
	const knownShare = sectionCoverage.filter((state) => state === "known").length / Math.max(1, sectionCoverage.length);
	return round(Math.min(0.95, Math.max(0, averageEvidence * (0.5 + knownShare * 0.5) * sampleFactor)), 3);
}

function maximum(values: Array<number | undefined>): number | undefined {
	const finite = values.filter((value): value is number => value !== undefined);
	return finite.length > 0 ? Math.max(...finite) : undefined;
}

export function buildProductMarketInsight(evidence: EvidenceItem[], cutoff: string): InsightDraft {
	const active = selectActiveEvidence(evidence, cutoff).filter((item) => {
		if (!PRODUCT_PREDICATES.has(item.predicate)) return false;
		if (INTERNAL_PROFIT_PREDICATES.has(item.predicate)) return item.evidenceClass === "internal_input";
		return item.subjectType === "product" || item.subjectType === "internal_product";
	});
	const subjectIds = [...new Set(active.map((item) => item.subjectId))];
	if (subjectIds.length !== 1) throw new Error("product insight requires evidence for exactly one canonical product");

	const byPredicate = (predicate: string) => active.filter((item) => item.predicate === predicate);
	const priceItems = byPredicate("price_jpy");
	const tvItems = active.filter((item) => item.predicate === "airing_count_30d" || item.predicate === "tv_airing_count");
	const reviewItems = byPredicate("review_count");
	const reviewAverageItems = active.filter((item) => item.predicate === "review_average" || item.predicate === "review_avg");
	const rankingItems = active.filter((item) => item.predicate === "ranking_position" || item.predicate === "sales_rank");
	const salesItems = byPredicate("actual_competitor_sales");
	const claimItems = active.filter((item) => SELLER_CLAIM_PREDICATES.has(item.predicate));
	const profitItems = active.filter((item) => INTERNAL_PROFIT_PREDICATES.has(item.predicate));

	const observedJpy = distribution(priceItems.map(finiteValue).filter((value): value is number => value !== undefined));
	const tvAirings30d = maximum(tvItems.map(finiteValue));
	const reviewCount = maximum(reviewItems.map(finiteValue));
	const reviewAverage = maximum(reviewAverageItems.map(finiteValue));
	const rankings = [...new Set(rankingItems.map(finiteValue).filter((value): value is number => value !== undefined))].sort((left, right) => left - right);
	const actualCompetitorSales = maximum(salesItems.map(finiteValue));
	const sellerClaims = claimItems
		.filter(known)
		.map((item) => ({ predicate: item.predicate, value: item.value }))
		.sort((left, right) => left.predicate.localeCompare(right.predicate) || stableJson(left.value).localeCompare(stableJson(right.value)));

	const grossMarginPct = maximum(byPredicate("gross_margin_pct").map(finiteValue));
	const grossProfitJpy = maximum(byPredicate("gross_profit_jpy").map(finiteValue));
	const profitPerUnitJpy = maximum(byPredicate("profit_per_unit_jpy").map(finiteValue));
	const profitability = grossMarginPct === undefined && grossProfitJpy === undefined && profitPerUnitJpy === undefined
		? undefined
		: {
			...(grossMarginPct !== undefined ? { grossMarginPct } : {}),
			...(grossProfitJpy !== undefined ? { grossProfitJpy } : {}),
			...(profitPerUnitJpy !== undefined ? { profitPerUnitJpy } : {}),
		};

	const priceCoverage = coverageState(priceItems);
	const tvCoverage = coverageState(tvItems);
	const reviewCoverage = coverageState([...reviewItems, ...reviewAverageItems]);
	const rankingCoverage = coverageState(rankingItems);
	const salesCoverage = coverageState(salesItems);
	const claimsCoverage = coverageState(claimItems);
	const profitabilityCoverage = coverageState(profitItems);

	return {
		insightType: PRODUCT_MARKET_INSIGHT_TYPE,
		subjectType: "product",
		subjectId: subjectIds[0],
		...commonDraft(active, cutoff),
		result: {
			price: { ...(observedJpy ? { observedJpy } : {}) },
			demand: {
				...(tvAirings30d !== undefined ? { tvAirings30d } : {}),
				...(reviewCount !== undefined ? { reviewCount } : {}),
				...(reviewAverage !== undefined ? { reviewAverage } : {}),
				...(rankings.length > 0 ? { rankingPositions: { best: rankings[0], observed: rankings } } : {}),
				...(actualCompetitorSales !== undefined ? { actualCompetitorSales } : {}),
			},
			sellerClaims,
			...(profitability ? { profitability } : {}),
		},
		coverage: {
			price: priceCoverage,
			demand: {
				tvAirings30d: tvCoverage,
				reviews: reviewCoverage,
				ranking: rankingCoverage,
				actualCompetitorSales: salesCoverage,
			},
			sellerClaims: claimsCoverage,
			profitability: profitabilityCoverage,
		},
		formulaVersion: PRODUCT_MARKET_FORMULA_VERSION,
		confidence: confidence(active, [priceCoverage, tvCoverage, reviewCoverage, rankingCoverage, claimsCoverage, profitabilityCoverage]),
	};
}

function hasKnownStructure(item: EvidenceItem): boolean {
	if (!known(item) || !STRUCTURE_PREDICATES.has(item.predicate)) return false;
	if (Array.isArray(item.value)) return item.value.length > 0;
	if (typeof item.value === "object") return Object.keys(item.value as Record<string, unknown>).length > 0;
	return Boolean(item.value);
}

export function buildBroadcastCategoryInsight(
	evidence: EvidenceItem[],
	category: string,
	cutoff: string,
): InsightDraft {
	const subjectId = category.trim();
	if (!subjectId) throw new Error("category insight requires a stored category");
	const active = selectActiveEvidence(evidence, cutoff)
		.filter((item) => item.subjectType === "broadcast" && CATEGORY_PREDICATES.has(item.predicate));
	if (active.length === 0) throw new Error("category insight requires active broadcast evidence");

	const broadcastIds = [...new Set(active.map((item) => item.subjectId))].sort();
	const priceItems = active.filter((item) => item.predicate === "price_jpy");
	const categoryItems = active.filter((item) => item.predicate === "category" || item.predicate === "normalized_category");
	const structureItems = active.filter((item) => STRUCTURE_PREDICATES.has(item.predicate));
	const airDateItems = active.filter((item) => item.predicate === "air_date");
	const observedDays = [...new Set(airDateItems.filter(known).map((item) => item.value).filter((value): value is string => typeof value === "string"))].sort();
	const prices = priceItems.map(finiteValue).filter((value): value is number => value !== undefined);
	const channelsByBroadcast = new Map<string, Set<string>>();
	for (const item of active) {
		if (!CHANNELS.has(item.sourceType)) continue;
		const channels = channelsByBroadcast.get(item.subjectId) ?? new Set<string>();
		channels.add(item.sourceType);
		channelsByBroadcast.set(item.subjectId, channels);
	}
	const byChannel: Record<string, number> = {};
	for (const broadcastId of broadcastIds) {
		for (const channel of [...(channelsByBroadcast.get(broadcastId) ?? [])].sort().slice(0, 1)) {
			byChannel[channel] = (byChannel[channel] ?? 0) + 1;
		}
	}
	const channels = Object.keys(byChannel).sort();
	const channelEntries = Object.entries(byChannel).sort(([leftChannel, leftCount], [rightChannel, rightCount]) =>
		rightCount - leftCount || leftChannel.localeCompare(rightChannel));
	const dominant = channelEntries[0];
	const broadcastsWithPatterns = new Set(structureItems.filter(hasKnownStructure).map((item) => item.subjectId)).size;

	const priceCoverage = coverageState(priceItems);
	const categoryCoverage = coverageState(categoryItems);
	const structureCoverage = coverageState(structureItems);
	const airDateCoverage = coverageState(airDateItems);
	const channelCoverage: CoverageState = channels.length > 0 ? "known" : "unknown";
	const sampleFactor = Math.min(1, Math.sqrt(broadcastIds.length / 10));

	return {
		insightType: BROADCAST_CATEGORY_INSIGHT_TYPE,
		subjectType: "category",
		subjectId,
		...commonDraft(active, cutoff),
		result: {
			sampleSize: broadcastIds.length,
			productDensity: {
				broadcasts: broadcastIds.length,
				...(observedDays.length > 0
					? { observedDays: observedDays.length, broadcastsPerObservedDay: round(broadcastIds.length / observedDays.length) }
					: {}),
			},
			...(prices.length > 0 ? { priceDistributionJpy: distribution(prices) } : {}),
			channels,
			...(structureCoverage === "known"
				? {
					structurePatternAvailability: {
						broadcastsWithPatterns,
						ratio: round(broadcastsWithPatterns / broadcastIds.length),
					},
				}
				: {}),
			categoryImbalance: {
				dominantChannel: dominant?.[0],
				dominantShare: dominant ? round(dominant[1] / broadcastIds.length) : undefined,
				byChannel: Object.fromEntries(Object.entries(byChannel).sort(([left], [right]) => left.localeCompare(right))),
			},
		},
		coverage: {
			analyzedSample: "known",
			categoryMembership: categoryCoverage,
			productDensity: airDateCoverage,
			priceDistribution: priceCoverage,
			channels: channelCoverage,
			structurePatterns: structureCoverage,
			categoryImbalance: channelCoverage,
		},
		formulaVersion: BROADCAST_CATEGORY_FORMULA_VERSION,
		confidence: confidence(active, [categoryCoverage, airDateCoverage, priceCoverage, channelCoverage, structureCoverage], sampleFactor),
	};
}
