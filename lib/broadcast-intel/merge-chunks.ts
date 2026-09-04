/**
 * Merge per-chunk analyses back into one programme-level analysis.
 *
 * A ShopCh programme runs ~63 minutes on average and up to two hours. Asked to
 * analyse one in a single call, the model fails two ways at once, both measured
 * on 2026-09-04 across 71 calls: 14% truncate at the 65,536 output ceiling
 * (billing the full allowance and returning nothing), and others return a
 * well-formed answer whose acts stop 17-30% into the runtime, which
 * assertActCoverage then rejects. About a third of the spend produced nothing.
 *
 * Splitting the audio fixes both, and costs almost nothing extra: audio input
 * tokens are proportional to duration, so N chunks of a programme carry the
 * same total input as one call over the whole of it, and the transcript they
 * produce is the same length whether it arrives in one response or five. Only
 * the prompt is repeated.
 *
 * Each chunk is analysed against its OWN timeline, starting at zero — asking
 * the model to add a global offset itself invites arithmetic errors in the one
 * field everything downstream is keyed on. This module adds the offsets.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type {
	AnalysisPatterns,
	AnalysisVerbatim,
	BroadcastAnalysis,
	PointType,
} from "./schema";

export interface AnalysisChunkResult {
	/** Where this chunk begins in the full programme. */
	offsetSec: number;
	/** The chunk's own runtime, as measured — not the nominal chunk length. */
	durationSec: number;
	analysis: BroadcastAnalysis;
}

/**
 * How close to a seam a boundary must fall to be treated as one.
 *
 * Only acts that meet EXACTLY at a chunk seam are rejoined. An act split by
 * the seam is an artifact this module introduced and should undo; two acts of
 * the same type that genuinely occur apart inside one chunk are real and must
 * survive. Anchoring the rule to the seam, rather than to "adjacent and same
 * type", is what keeps those two cases apart — over-merging would distort act
 * counts in the aggregate more than leaving a seam split would.
 */
const SEAM_TOLERANCE_SEC = 2;

function clamp(value: number, maxSec: number): number {
	return Math.min(Math.max(value, 0), maxSec);
}

/** Sum of repeat counts, earliest first mention — the model counts repeats
 *  within the audio it was given, so a point raised in three chunks was raised
 *  in all three. */
function mergeSellingPoints(
	chunks: readonly AnalysisChunkResult[],
	totalSec: number,
): AnalysisPatterns["sellingPoints"] {
	const byType = new Map<PointType, { firstMentionedSec: number; repeatCount: number }>();
	for (const chunk of chunks) {
		for (const sp of chunk.analysis.patterns.sellingPoints) {
			const at = clamp(sp.firstMentionedSec + chunk.offsetSec, totalSec);
			const seen = byType.get(sp.pointType);
			if (!seen) {
				byType.set(sp.pointType, { firstMentionedSec: at, repeatCount: sp.repeatCount });
				continue;
			}
			seen.firstMentionedSec = Math.min(seen.firstMentionedSec, at);
			seen.repeatCount += sp.repeatCount;
		}
	}
	// `order` is positional and derived, exactly as parseAnalysisResponse does
	// it — never carried over from a chunk, where it only ranked that chunk.
	return [...byType.entries()]
		.map(([pointType, v]) => ({ pointType, ...v }))
		.sort((a, b) => a.firstMentionedSec - b.firstMentionedSec || a.pointType.localeCompare(b.pointType))
		.map((sp, i) => ({ order: i + 1, ...sp }));
}

/** Rejoin an act the seam cut in half: same type, one ending where the next
 *  begins, at a seam. Summaries are concatenated so no evidence is dropped. */
function coalesceAtSeams<T extends { startSec: number; endSec: number; actType: string }>(
	segments: readonly T[],
	seams: readonly number[],
	joinSummary: (a: T, b: T) => T,
): T[] {
	if (segments.length === 0) return [];
	const atSeam = (sec: number) => seams.some((s) => Math.abs(sec - s) <= SEAM_TOLERANCE_SEC);

	const out: T[] = [{ ...segments[0]! }];
	for (let i = 1; i < segments.length; i++) {
		const prev = out[out.length - 1]!;
		const next = segments[i]!;
		const meetAtSeam =
			prev.actType === next.actType &&
			atSeam(prev.endSec) &&
			Math.abs(next.startSec - prev.endSec) <= SEAM_TOLERANCE_SEC;
		if (meetAtSeam) out[out.length - 1] = joinSummary(prev, next);
		else out.push({ ...next });
	}
	return out;
}

export function mergeChunkAnalyses(
	chunks: readonly AnalysisChunkResult[],
	totalDurationSec: number,
): BroadcastAnalysis {
	if (chunks.length === 0) {
		throw new Error("broadcast-intel: cannot merge an empty chunk list");
	}
	const ordered = [...chunks].sort((a, b) => a.offsetSec - b.offsetSec);
	const seams = ordered.slice(1).map((c) => c.offsetSec);
	const shift = (sec: number, offset: number) => clamp(sec + offset, totalDurationSec);

	const transcript: AnalysisVerbatim["transcript"] = ordered
		.flatMap((c) =>
			c.analysis.verbatim.transcript.map((t) => ({
				...t,
				startSec: shift(t.startSec, c.offsetSec),
				endSec: shift(t.endSec, c.offsetSec),
			})),
		)
		.sort((a, b) => a.startSec - b.startSec);

	const actSummaries = coalesceAtSeams(
		ordered
			.flatMap((c) =>
				c.analysis.verbatim.actSummaries.map((s) => ({
					...s,
					startSec: shift(s.startSec, c.offsetSec),
					endSec: shift(s.endSec, c.offsetSec),
				})),
			)
			.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec),
		seams,
		(a, b) => ({
			...a,
			endSec: b.endSec,
			summaryJa: [a.summaryJa, b.summaryJa].filter(Boolean).join(" "),
		}),
	);

	// Derived from the coalesced summaries so the two views cannot disagree
	// about where an act starts and ends — persist.ts writes them to different
	// tables, and a reader joining the two would see a contradiction otherwise.
	const segments = actSummaries.map(({ startSec, endSec, actType }) => ({ startSec, endSec, actType }));

	const evidenceCues = ordered
		.flatMap((c) =>
			c.analysis.patterns.evidenceCues.map((e) => ({ ...e, atSec: shift(e.atSec, c.offsetSec) })),
		)
		.sort((a, b) => a.atSec - b.atSec);

	const objectionHandlings = ordered
		.flatMap((c) =>
			c.analysis.patterns.objectionHandlings.map((o) => ({
				...o,
				atSec: shift(o.atSec, c.offsetSec),
			})),
		)
		.sort((a, b) => a.atSec - b.atSec);

	// The FIRST price in the programme, not the first in every chunk: a price
	// repeated in each of five chunks must not read as five separate offers.
	const firstPriceSec = ordered.reduce<number | null>((first, c) => {
		const raw = c.analysis.patterns.offerTimeline.firstPriceSec;
		if (raw === null) return first;
		const at = shift(raw, c.offsetSec);
		return first === null ? at : Math.min(first, at);
	}, null);

	const ctaSecs = [
		...new Set(
			ordered.flatMap((c) =>
				c.analysis.patterns.offerTimeline.ctaSecs.map((s) => shift(s, c.offsetSec)),
			),
		),
	].sort((a, b) => a - b);

	const urgencyCues = [...new Set(ordered.flatMap((c) => c.analysis.verbatim.urgencyCues))];

	return {
		patterns: {
			segments,
			sellingPoints: mergeSellingPoints(ordered, totalDurationSec),
			evidenceCues,
			objectionHandlings,
			offerTimeline: { firstPriceSec, ctaSecs },
		},
		verbatim: { transcript, actSummaries, urgencyCues },
	};
}
