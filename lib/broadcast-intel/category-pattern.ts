/**
 * Same-category aggregation into runtime-relative structural patterns.
 *
 * Three rules carry the design:
 *  1. Everything is a SHARE of the runtime. Slots run 12 to 50 minutes;
 *     averaging raw seconds across them is meaningless.
 *  2. The sample floor is fail-CLOSED. competitor_fit_analyses (7 rows total)
 *     shows what an under-sampled "aggregate" is worth.
 *  3. Category matching is EXACT against the channel whitelist this cycle.
 *     lib/strategy/category-mapping.ts maps to the internal SALES taxonomy, not
 *     the broadcast one — 家電 happens to exist in both, but 美容・スキンケア
 *     would expand to 化粧品/美容 and match neither ビューティ nor コスメ,
 *     returning null for most categories while looking like it worked.
 *     A real broadcast-category mapper is deferred (spec §15).
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import { getServiceClient } from "@/lib/supabase";
import { selectAllPages } from "@/lib/supabase/paginate";
import { CATEGORIES_BY_CHANNEL } from "@/lib/broadcasts/whitelist-gate";
import type { ActType, EvidenceType, ObjectionType, PointType } from "./schema";

export const MIN_SAMPLES = Number(process.env.BROADCAST_INTEL_MIN_SAMPLES) || 5;
const LOOKBACK_DAYS = Number(process.env.BROADCAST_INTEL_LOOKBACK_DAYS) || 180;
const MAX_ROWS = 5_000;

export interface AnalysisRow {
	duration_sec: number;
	channel: "qvc" | "shopch";
	segments: Array<{ startSec: number; endSec: number; actType: ActType }>;
	selling_points: Array<{ order: number; pointType: PointType; firstMentionedSec: number; repeatCount: number }>;
	evidence_cues: Array<{ type: EvidenceType; atSec: number }>;
	objection_handlings: Array<{ objectionType: ObjectionType; atSec: number }>;
	offer_timeline: { firstPriceSec: number | null; ctaSecs: number[] };
}

export interface CategoryPattern {
	category: string;
	sampleSize: number;
	channels: string[];
	runtimeMedianSec: number;
	actSequence: Array<{ actType: ActType; medianShare: number; medianStartShare: number; presenceRate: number }>;
	sellingPointOrder: Array<{ pointType: PointType; medianOrder: number; presenceRate: number }>;
	evidenceMix: Array<{ type: EvidenceType; presenceRate: number }>;
	objectionMix: Array<{ type: ObjectionType; presenceRate: number }>;
	offerTiming: { firstPriceShare: number | null; firstPriceMedianSec: number | null; ctaCountMedian: number };
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

export function aggregatePattern(rows: AnalysisRow[], category: string): CategoryPattern | null {
	const usable = rows.filter((r) => r.duration_sec > 0);
	if (usable.length < MIN_SAMPLES) return null;

	const runtimeMedianSec = median(usable.map((r) => r.duration_sec))!;

	const actShares = new Map<ActType, number[]>();
	const actStarts = new Map<ActType, number[]>();
	const actPresence = new Map<ActType, number>();
	for (const r of usable) {
		for (const seg of r.segments) {
			const share = (seg.endSec - seg.startSec) / r.duration_sec;
			if (!(share > 0)) continue;
			push(actShares, seg.actType, share);
			push(actStarts, seg.actType, seg.startSec / r.duration_sec);
		}
		for (const t of new Set(r.segments.map((s) => s.actType))) {
			actPresence.set(t, (actPresence.get(t) ?? 0) + 1);
		}
	}
	// medianShare values are independent medians and do NOT sum to 1; an act
	// appearing twice in one broadcast is counted twice. presenceRate is what
	// tells a reader how universal each act is — the prompt must show it.
	const actSequence = [...actShares.entries()]
		.map(([actType, shares]) => ({
			actType,
			medianShare: median(shares)!,
			medianStartShare: median(actStarts.get(actType)!)!,
			presenceRate: (actPresence.get(actType) ?? 0) / usable.length,
		}))
		.sort((a, b) => a.medianStartShare - b.medianStartShare);

	const pointOrders = new Map<PointType, number[]>();
	const pointPresence = new Map<PointType, number>();
	for (const r of usable) {
		for (const sp of r.selling_points) push(pointOrders, sp.pointType, sp.order);
		for (const t of new Set(r.selling_points.map((s) => s.pointType))) {
			pointPresence.set(t, (pointPresence.get(t) ?? 0) + 1);
		}
	}
	const sellingPointOrder = [...pointOrders.entries()]
		.map(([pointType, orders]) => ({
			pointType,
			medianOrder: median(orders)!,
			presenceRate: (pointPresence.get(pointType) ?? 0) / usable.length,
		}))
		.sort((a, b) => a.medianOrder - b.medianOrder);

	function rate<K extends string>(pick: (r: AnalysisRow) => K[]): Array<{ key: K; presenceRate: number }> {
		const counts = new Map<K, number>();
		for (const r of usable) {
			for (const k of new Set(pick(r))) counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([key, n]) => ({ key, presenceRate: n / usable.length }))
			.sort((a, b) => b.presenceRate - a.presenceRate);
	}

	const evidenceMix = rate<EvidenceType>((r) => r.evidence_cues.map((c) => c.type))
		.map(({ key, presenceRate }) => ({ type: key, presenceRate }));
	const objectionMix = rate<ObjectionType>((r) => r.objection_handlings.map((o) => o.objectionType))
		.map(({ key, presenceRate }) => ({ type: key, presenceRate }));

	// A slot that never announced a price contributes nothing here; counting it
	// as second 0 would drag the median toward the opening.
	const firstPriceShare = median(
		usable
			.filter((r) => r.offer_timeline.firstPriceSec !== null)
			.map((r) => r.offer_timeline.firstPriceSec! / r.duration_sec),
	);

	return {
		category,
		sampleSize: usable.length,
		channels: [...new Set(usable.map((r) => r.channel))].sort(),
		runtimeMedianSec,
		actSequence,
		sellingPointOrder,
		evidenceMix,
		objectionMix,
		offerTiming: {
			firstPriceShare,
			firstPriceMedianSec: firstPriceShare === null ? null : Math.round(firstPriceShare * runtimeMedianSec),
			ctaCountMedian: median(usable.map((r) => r.offer_timeline.ctaSecs.length)) ?? 0,
		},
	};
}

const ALL_WHITELIST_CATEGORIES = new Set<string>([
	...CATEGORIES_BY_CHANNEL.qvc,
	...CATEGORIES_BY_CHANNEL.shopch,
]);

/** Returns null when the category is unknown, off-whitelist, or under-sampled —
 *  the caller then injects nothing. */
export async function loadCategoryPattern(category: string | null): Promise<CategoryPattern | null> {
	if (!category || !ALL_WHITELIST_CATEGORIES.has(category)) return null;

	const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
	const sb = getServiceClient();

	const rows = await selectAllPages<AnalysisRow>(
		(range) =>
			sb
				.from("broadcast_speech_analyses")
				.select("duration_sec, channel, segments, selling_points, evidence_cues, objection_handlings, offer_timeline")
				.eq("category", category)
				.gte("air_date", cutoff)
				.order("broadcast_id", { ascending: true })
				.range(range.from, range.to),
		{ label: "broadcast-intel:category-pattern", maxRows: MAX_ROWS },
	);

	return aggregatePattern(rows, category);
}
