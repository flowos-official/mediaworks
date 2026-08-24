/**
 * Writes one analysis to two tables along the verbatim/pattern split that
 * schema.ts already made. `analysis.patterns` is the ONLY thing that may reach
 * broadcast_speech_analyses; `analysis.verbatim` is the only thing that may
 * reach broadcast_transcripts.
 */
import { getServiceClient } from "@/lib/supabase";
import { SCHEMA_VERSION, type BroadcastAnalysis } from "./schema";

export interface PersistInput {
	broadcastId: string;
	channel: "qvc" | "shopch";
	airDate: string;
	category: string | null;
	durationSec: number;
	analysis: BroadcastAnalysis;
	model: string;
}

export async function persistAnalysis(input: PersistInput): Promise<void> {
	const sb = getServiceClient();
	const { patterns, verbatim } = input.analysis;

	const { error: transcriptErr } = await sb.from("broadcast_transcripts").upsert({
		broadcast_id: input.broadcastId,
		segments: verbatim.transcript,
		act_summaries: verbatim.actSummaries,
		urgency_cues: verbatim.urgencyCues,
		language: "ja",
		model: input.model,
		schema_version: SCHEMA_VERSION,
	});
	if (transcriptErr) throw new Error(`transcript upsert failed: ${transcriptErr.message}`);

	const { error: analysisErr } = await sb.from("broadcast_speech_analyses").upsert({
		broadcast_id: input.broadcastId,
		channel: input.channel,
		air_date: input.airDate,
		category: input.category,
		duration_sec: input.durationSec,
		segments: patterns.segments,
		selling_points: patterns.sellingPoints,
		evidence_cues: patterns.evidenceCues,
		objection_handlings: patterns.objectionHandlings,
		offer_timeline: patterns.offerTimeline,
		model: input.model,
		schema_version: SCHEMA_VERSION,
	});
	if (analysisErr) throw new Error(`analysis upsert failed: ${analysisErr.message}`);
}
