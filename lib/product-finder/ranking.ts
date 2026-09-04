/**
 * Rank stored candidates without inventing what is not there.
 *
 * Two properties matter more than the exact weights:
 *
 * 1. A missing input becomes `{ status: "unknown", normalized: null }`, never
 *    0. `?? 0` is the whole bug in one operator — it converts a gap in our
 *    collection into a real low score, and the operator reads a product we
 *    have never priced as one we priced and rejected. A static test forbids the
 *    operator outright in this file.
 *
 * 2. Profitability is not folded into the opportunity index. Contribution
 *    profit is a different KIND of statement from a demand proxy, and averaging
 *    the two produces a number that is neither. Known profit is a SORT key
 *    ahead of the index instead, so a measured margin wins on its own terms
 *    while unpriced candidates stay comparable to each other.
 *
 * Normalisation is percentile rank within the candidate set, not a clamped raw
 * sum. Airing counts and review counts have no natural ceiling, so any fixed
 * divisor is a guess that silently saturates once one product exceeds it.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { StoredCandidate, StoredSignal } from "./candidates";
import type { AxisKey, AxisStatus, ProductFinderQuery, ScoreAxis } from "./types";
import { AXIS_KEYS } from "./types";

export const ALGORITHM_VERSION = "stored-only-v1";

/** Weights over the non-profit axes, renormalised across whichever are
 *  available — a candidate is never penalised for an axis nobody could
 *  measure, only for a low one. */
const AXIS_WEIGHTS: Record<Exclude<AxisKey, "profitability">, number> = {
	market_demand: 0.4,
	company_fit: 0.25,
	broadcast_fit: 0.2,
	competition_headroom: 0.15,
};

export interface RankedCandidate {
	canonicalProductId: string;
	name: string;
	category: string | null;
	rank: number;
	opportunityIndex: number;
	expectedContributionProfitJpy: number | null;
	axes: ScoreAxis[];
	confidence: { level: "high" | "medium" | "low"; coverage: number };
	evidenceIds: string[];
}

/**
 * The raw quantities an axis can be built from. Each is normalised against its
 * OWN population before axes are assembled.
 *
 * The earlier shape summed an axis's sub-signals and let a missing one
 * contribute 0. That is the same unknown-as-zero bug one level down: a product
 * with airings but no review data scored identically to one with airings and
 * genuinely zero reviews. Percentile-per-signal, then a mean over the signals
 * that exist, keeps a gap from acting like a low value.
 */
type SignalKey =
	| "recentAirings"
	| "tvAirings"
	| "reviewCount"
	| "priceFit"
	| "internalMarginRate"
	| "internalProfitJpy"
	| "broadcastPatternSample";

interface AxisInput {
	/** Which raw signals feed this axis. Absent ones are skipped, not zeroed. */
	parts: Array<{ key: SignalKey; invert?: boolean }>;
	status: AxisStatus;
	evidenceIds: string[];
	/** Only profitability carries an absolute value through to the caller. */
	absolute?: number;
}

const AXIS_LABELS: Record<AxisKey, string> = {
	market_demand: "市場需要",
	company_fit: "自社適合",
	profitability: "収益性",
	competition_headroom: "競合余地",
	broadcast_fit: "放送適合",
};

/** The weakest class among the signals that fed an axis. An axis built partly
 *  from a proxy is a proxy; calling it measured would launder the weaker
 *  input. */
function combinedStatus(signals: Array<StoredSignal<number> | undefined>): AxisStatus {
	const present = signals.filter((s): s is StoredSignal<number> => s !== undefined);
	if (present.length === 0) return "unknown";
	return present.every((s) => s.evidenceClass === "verified" || s.evidenceClass === "internal_input")
		? "measured"
		: "proxy";
}

function idsOf(signals: Array<StoredSignal<unknown> | undefined>): string[] {
	return signals.filter((s) => s !== undefined).map((s) => s!.evidenceItemId);
}

/**
 * Percentile rank of `value` among `population`, in [0,1].
 *
 * A single-member population has no spread to describe, so it scores 0.5 —
 * the honest midpoint — rather than 1, which would let any lone candidate
 * claim the top of every axis it happens to have data for.
 */
function percentile(value: number, population: readonly number[]): number {
	if (population.length <= 1) return 0.5;
	const below = population.filter((v) => v < value).length;
	const equal = population.filter((v) => v === value).length;
	return (below + (equal - 1) / 2) / (population.length - 1);
}

/** The raw value of each signal for one candidate. Absent stays absent. */
function rawSignals(
	c: StoredCandidate,
	query: ProductFinderQuery,
): Partial<Record<SignalKey, number>> {
	const s = c.signals;
	// Price contributes to company fit only when it lands inside the band the
	// operator asked for. Outside it, price is not evidence of fit at all —
	// which is different from evidence of poor fit, so it is simply absent.
	const priceInBand =
		s.priceJpy !== undefined &&
		(query.priceMinJpy === undefined || s.priceJpy.value >= query.priceMinJpy) &&
		(query.priceMaxJpy === undefined || s.priceJpy.value <= query.priceMaxJpy);

	const out: Partial<Record<SignalKey, number>> = {};
	if (s.recentAirings !== undefined) out.recentAirings = s.recentAirings.value;
	if (s.tvAirings !== undefined) out.tvAirings = s.tvAirings.value;
	if (s.reviewCount !== undefined) out.reviewCount = s.reviewCount.value;
	if (priceInBand && s.priceJpy !== undefined) out.priceFit = s.priceJpy.value;
	if (s.internalMarginRate !== undefined) out.internalMarginRate = s.internalMarginRate.value;
	if (s.internalProfitJpy !== undefined) out.internalProfitJpy = s.internalProfitJpy.value;
	if (s.broadcastPatternSample !== undefined) out.broadcastPatternSample = s.broadcastPatternSample.value;
	return out;
}

function axisInputs(c: StoredCandidate): Record<AxisKey, AxisInput> {
	const s = c.signals;
	const demandSignals = [s.recentAirings, s.tvAirings, s.reviewCount];
	const fitSignals = [s.internalMarginRate, s.priceJpy];
	return {
		market_demand: {
			parts: [{ key: "recentAirings" }, { key: "tvAirings" }, { key: "reviewCount" }],
			status: combinedStatus(demandSignals),
			evidenceIds: idsOf(demandSignals),
		},
		company_fit: {
			parts: [{ key: "internalMarginRate" }, { key: "priceFit" }],
			status: combinedStatus(fitSignals),
			evidenceIds: idsOf(fitSignals),
		},
		profitability: {
			parts: [{ key: "internalProfitJpy" }],
			status: s.internalProfitJpy ? "measured" : "unknown",
			evidenceIds: idsOf([s.internalProfitJpy, s.internalMarginRate]),
			absolute: s.internalProfitJpy?.value,
		},
		competition_headroom: {
			// Fewer competitor airings means more room, so this one inverts.
			parts: [{ key: "tvAirings", invert: true }],
			status: combinedStatus([s.tvAirings]),
			evidenceIds: idsOf([s.tvAirings]),
		},
		broadcast_fit: {
			parts: [{ key: "broadcastPatternSample" }],
			status: combinedStatus([s.broadcastPatternSample]),
			evidenceIds: idsOf([s.broadcastPatternSample]),
		},
	};
}

export function rankStoredCandidates(
	candidates: readonly StoredCandidate[],
	query: ProductFinderQuery,
): RankedCandidate[] {
	const inputs = candidates.map((c) => ({
		candidate: c,
		axes: axisInputs(c),
		raw: rawSignals(c, query),
	}));

	// One population per RAW signal, holding only the candidates that actually
	// have it. A percentile is then always computed against peers that share
	// the datum, never against candidates we simply never measured.
	const populations = new Map<SignalKey, number[]>();
	for (const { raw } of inputs) {
		for (const [key, value] of Object.entries(raw) as Array<[SignalKey, number]>) {
			const held = populations.get(key);
			if (held) held.push(value);
			else populations.set(key, [value]);
		}
	}

	const scored = inputs.map(({ candidate, axes, raw }) => {
		const scoredAxes: ScoreAxis[] = AXIS_KEYS.map((key) => {
			const input = axes[key];
			const unknown = {
				key,
				status: "unknown" as const,
				normalized: null,
				label: AXIS_LABELS[key],
				evidenceIds: input.evidenceIds,
			};
			if (input.status === "unknown") return unknown;

			// Mean over the parts this candidate HAS. A part it lacks is skipped,
			// so a gap neither raises nor lowers the axis.
			const present = input.parts
				.map((part) => {
					const value = raw[part.key];
					if (value === undefined) return undefined;
					const pct = percentile(value, populations.get(part.key) ?? [value]);
					return part.invert === true ? 1 - pct : pct;
				})
				.filter((v): v is number => v !== undefined);
			if (present.length === 0) return unknown;

			return {
				key,
				status: input.status,
				normalized: present.reduce((total, v) => total + v, 0) / present.length,
				label: AXIS_LABELS[key],
				evidenceIds: input.evidenceIds,
			};
		});

		const weighted = scoredAxes.filter(
			(a): a is ScoreAxis & { normalized: number } =>
				a.key !== "profitability" && a.normalized !== null,
		);
		const weightTotal = weighted.reduce(
			(total, a) => total + AXIS_WEIGHTS[a.key as keyof typeof AXIS_WEIGHTS],
			0,
		);
		// No measurable axis means no basis for ordering this candidate up. The
		// index is 0, and every axis reads `unknown` in the UI beside it — this
		// is the absence of a claim, not a claim of zero merit.
		const opportunityIndex =
			weightTotal === 0
				? 0
				: weighted.reduce(
						(total, a) => total + a.normalized * AXIS_WEIGHTS[a.key as keyof typeof AXIS_WEIGHTS],
						0,
					) / weightTotal;

		const known = scoredAxes.filter((a) => a.status !== "unknown").length;
		const coverage = known / AXIS_KEYS.length;
		const level: "high" | "medium" | "low" =
			coverage >= 0.6 ? "high" : coverage >= 0.3 ? "medium" : "low";

		return {
			canonicalProductId: candidate.canonicalProductId,
			name: candidate.name,
			category: candidate.category,
			opportunityIndex,
			expectedContributionProfitJpy:
				axes.profitability.absolute === undefined ? null : axes.profitability.absolute,
			axes: scoredAxes,
			confidence: { level, coverage },
			evidenceIds: candidate.evidenceIds,
		};
	});

	// Known profit first, then the index. Ties break on id so the ordering does
	// not depend on the order rows came back from the database.
	scored.sort((a, b) => {
		const aProfit = a.expectedContributionProfitJpy;
		const bProfit = b.expectedContributionProfitJpy;
		if (aProfit !== null && bProfit !== null && aProfit !== bProfit) return bProfit - aProfit;
		if (aProfit !== null && bProfit === null) return -1;
		if (aProfit === null && bProfit !== null) return 1;
		if (a.opportunityIndex !== b.opportunityIndex) return b.opportunityIndex - a.opportunityIndex;
		return a.canonicalProductId.localeCompare(b.canonicalProductId);
	});

	return scored.map((item, i) => ({ ...item, rank: i + 1 }));
}
