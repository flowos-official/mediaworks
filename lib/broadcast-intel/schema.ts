/**
 * Enums, Gemini response schema and validated result types.
 *
 * parseAnalysisResponse splits its output in two: `patterns` (numbers and enum
 * labels, destined for the member-readable table) and `verbatim` (free text,
 * destined for the admin-only transcripts table). The split is a type, not a
 * convention, so persist.ts cannot mix them up.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */

export const SCHEMA_VERSION = 1;

export const ACT_TYPES = [
	"opening", "problem", "product_intro", "demo", "evidence",
	"testimonial", "offer", "cta", "closing",
] as const;

export const POINT_TYPES = [
	"efficacy", "ease_of_use", "price_value", "safety", "size_fit",
	"durability", "design", "aftercare", "scarcity",
] as const;

export const EVIDENCE_TYPES = [
	"lab_test", "demo", "comparison", "testimonial", "expert", "certification",
] as const;

export const OBJECTION_TYPES = [
	"price", "doubt_efficacy", "difficulty", "space", "maintenance", "timing",
] as const;

export type ActType = (typeof ACT_TYPES)[number];
export type PointType = (typeof POINT_TYPES)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type ObjectionType = (typeof OBJECTION_TYPES)[number];

export interface TranscriptSegment {
	startSec: number;
	endSec: number;
	speakerHint: string | null;
	textJa: string;
}

/** Member-readable half. Every value here is a number or an enum label. */
export interface AnalysisPatterns {
	segments: Array<{ startSec: number; endSec: number; actType: ActType }>;
	sellingPoints: Array<{ order: number; pointType: PointType; firstMentionedSec: number; repeatCount: number }>;
	evidenceCues: Array<{ type: EvidenceType; atSec: number }>;
	objectionHandlings: Array<{ objectionType: ObjectionType; atSec: number }>;
	offerTimeline: { firstPriceSec: number | null; ctaSecs: number[] };
}

/** Admin-only half. */
export interface AnalysisVerbatim {
	transcript: TranscriptSegment[];
	actSummaries: Array<{ startSec: number; endSec: number; actType: ActType; summaryJa: string }>;
	urgencyCues: string[];
}

export interface BroadcastAnalysis {
	patterns: AnalysisPatterns;
	verbatim: AnalysisVerbatim;
}

export const ANALYSIS_RESPONSE_SCHEMA = {
	type: "object",
	required: ["transcript", "segments", "selling_points", "evidence_cues", "objection_handlings", "offer_timeline"],
	properties: {
		transcript: {
			type: "array",
			items: {
				type: "object",
				required: ["start_sec", "end_sec", "text_ja"],
				properties: {
					start_sec: { type: "number" },
					end_sec: { type: "number" },
					speaker_hint: { type: "string" },
					text_ja: { type: "string" },
				},
			},
		},
		segments: {
			type: "array",
			items: {
				type: "object",
				required: ["start_sec", "end_sec", "act_type", "summary_ja"],
				properties: {
					start_sec: { type: "number" },
					end_sec: { type: "number" },
					act_type: { type: "string", enum: [...ACT_TYPES] },
					summary_ja: { type: "string" },
				},
			},
		},
		selling_points: {
			type: "array",
			items: {
				type: "object",
				required: ["order", "point_type", "first_mentioned_sec", "repeat_count"],
				properties: {
					order: { type: "number" },
					point_type: { type: "string", enum: [...POINT_TYPES] },
					first_mentioned_sec: { type: "number" },
					repeat_count: { type: "number" },
				},
			},
		},
		evidence_cues: {
			type: "array",
			items: {
				type: "object",
				required: ["type", "at_sec"],
				properties: {
					type: { type: "string", enum: [...EVIDENCE_TYPES] },
					at_sec: { type: "number" },
				},
			},
		},
		objection_handlings: {
			type: "array",
			items: {
				type: "object",
				required: ["objection_type", "at_sec"],
				properties: {
					objection_type: { type: "string", enum: [...OBJECTION_TYPES] },
					at_sec: { type: "number" },
				},
			},
		},
		offer_timeline: {
			type: "object",
			required: ["cta_secs", "urgency_cues"],
			properties: {
				first_price_sec: { type: "number" },
				cta_secs: { type: "array", items: { type: "number" } },
				urgency_cues: { type: "array", items: { type: "string" } },
			},
		},
	},
} as const;

function arr(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`broadcast-intel: ${field} must be an array`);
	return value;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Coerce a raw Gemini payload into the validated shape.
 *  Unknown enum members and out-of-range timecodes are DROPPED, never guessed:
 *  a wrong act label distorts the aggregate more than a missing one. */
export function parseAnalysisResponse(raw: unknown, durationSec: number): BroadcastAnalysis {
	const r = (raw ?? {}) as Record<string, unknown>;
	const inRange = (v: number | null): v is number => v !== null && v >= 0 && v <= durationSec;

	const acts = new Set<string>(ACT_TYPES);
	const points = new Set<string>(POINT_TYPES);
	const evidence = new Set<string>(EVIDENCE_TYPES);
	const objections = new Set<string>(OBJECTION_TYPES);

	const transcript: TranscriptSegment[] = arr(r.transcript, "transcript").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const start = num(o.start_sec);
		const end = num(o.end_sec);
		if (!inRange(start) || end === null || typeof o.text_ja !== "string") return [];
		return [{
			startSec: start,
			endSec: end,
			speakerHint: typeof o.speaker_hint === "string" ? o.speaker_hint : null,
			textJa: o.text_ja,
		}];
	});

	const segmentsRaw = arr(r.segments, "segments").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const start = num(o.start_sec);
		const end = num(o.end_sec);
		if (!inRange(start) || !inRange(end) || typeof o.act_type !== "string") return [];
		if (!acts.has(o.act_type)) return [];
		return [{
			startSec: start,
			endSec: end,
			actType: o.act_type as ActType,
			summaryJa: typeof o.summary_ja === "string" ? o.summary_ja : "",
		}];
	});

	const sellingPoints = arr(r.selling_points, "selling_points").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const first = num(o.first_mentioned_sec);
		if (!inRange(first) || typeof o.point_type !== "string" || !points.has(o.point_type)) return [];
		return [{
			order: num(o.order) ?? 0,
			pointType: o.point_type as PointType,
			firstMentionedSec: first,
			repeatCount: Math.max(1, Math.round(num(o.repeat_count) ?? 1)),
		}];
	});

	const evidenceCues = arr(r.evidence_cues, "evidence_cues").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const at = num(o.at_sec);
		if (!inRange(at) || typeof o.type !== "string" || !evidence.has(o.type)) return [];
		return [{ type: o.type as EvidenceType, atSec: at }];
	});

	const objectionHandlings = arr(r.objection_handlings, "objection_handlings").flatMap((row) => {
		const o = row as Record<string, unknown>;
		const at = num(o.at_sec);
		if (!inRange(at) || typeof o.objection_type !== "string" || !objections.has(o.objection_type)) return [];
		return [{ objectionType: o.objection_type as ObjectionType, atSec: at }];
	});

	const offer = (r.offer_timeline ?? {}) as Record<string, unknown>;
	const firstPrice = num(offer.first_price_sec);

	return {
		patterns: {
			// Strip summaryJa here — this is the object that reaches the
			// member-readable table.
			segments: segmentsRaw.map(({ startSec, endSec, actType }) => ({ startSec, endSec, actType })),
			sellingPoints,
			evidenceCues,
			objectionHandlings,
			offerTimeline: {
				firstPriceSec: inRange(firstPrice) ? firstPrice : null,
				ctaSecs: (Array.isArray(offer.cta_secs) ? offer.cta_secs : []).map(num).filter(inRange),
			},
		},
		verbatim: {
			transcript,
			actSummaries: segmentsRaw,
			urgencyCues: (Array.isArray(offer.urgency_cues) ? offer.urgency_cues : [])
				.filter((v): v is string => typeof v === "string"),
		},
	};
}
