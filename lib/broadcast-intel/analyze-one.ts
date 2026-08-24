/**
 * Single-slot analysis job, modelled on lib/broadcasts/video-archival.ts.
 *
 * Failure model: a retryable throw rolls the slot back to `queued` with an
 * incremented attempt count; NonRetryableAudioError pins it to `failed`
 * immediately, because repeating it means re-downloading 606 MB for the same
 * outcome. At attempts >= MAX_ATTEMPTS the slot becomes `failed`.
 */
import { getServiceClient } from "@/lib/supabase";
import { extractAudio, NonRetryableAudioError } from "./audio-extract";
import { analyzeAudio } from "./gemini-analyze";
import { persistAnalysis } from "./persist";

export const MAX_ATTEMPTS = Number(process.env.BROADCAST_INTEL_MAX_ATTEMPTS) || 3;

export interface QueuedAnalysisSlot {
	id: string;
	channel: "qvc" | "shopch";
	air_date: string;
	category: string | null;
	archived_video_s3: string | null;
	analysis_attempts: number;
}

export interface AnalyzeResult {
	broadcastId: string;
	status: "done" | "queued" | "failed" | "skipped";
	durationSec?: number;
	error?: string;
}

export async function analyzeOne(slot: QueuedAnalysisSlot): Promise<AnalyzeResult> {
	const sb = getServiceClient();
	const broadcastId = slot.id;

	// Claim so a parallel drain does not double-spend a Gemini call.
	const { data: claimed, error: claimErr } = await sb
		.from("broadcasts")
		.update({ analysis_status: "running" })
		.eq("id", broadcastId)
		.eq("analysis_status", "queued")
		.select("id");
	if (claimErr) return { broadcastId, status: "queued", error: claimErr.message };
	if (!claimed || claimed.length === 0) {
		return { broadcastId, status: "skipped", error: "claim lost: slot was no longer queued" };
	}

	// Conditions can break between seeding and running (e.g. a category edit).
	if (!slot.archived_video_s3 || !slot.category) {
		const reason = !slot.archived_video_s3 ? "no archived video" : "no category to aggregate under";
		await sb.from("broadcasts")
			.update({ analysis_status: "skipped", analysis_error: reason })
			.eq("id", broadcastId).eq("analysis_status", "running");
		return { broadcastId, status: "skipped", error: reason };
	}

	try {
		const { audio, durationSec } = await extractAudio(slot.archived_video_s3);
		const { analysis, model } = await analyzeAudio(audio, durationSec);

		await persistAnalysis({
			broadcastId,
			channel: slot.channel,
			airDate: slot.air_date,
			category: slot.category,
			durationSec,
			analysis,
			model,
		});

		// Backfill the runtime the archival pass could never learn.
		const { error: updateErr } = await sb.from("broadcasts").update({
			analysis_status: "done",
			analysis_error: null,
			analyzed_at: new Date().toISOString(),
			video_duration_sec: durationSec,
		}).eq("id", broadcastId).eq("analysis_status", "running");
		if (updateErr) return { broadcastId, status: "queued", error: updateErr.message };

		return { broadcastId, status: "done", durationSec };
	} catch (e) {
		const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
		const attempts = (slot.analysis_attempts ?? 0) + 1;
		const permanent = e instanceof NonRetryableAudioError || attempts >= MAX_ATTEMPTS;
		await sb.from("broadcasts").update({
			analysis_status: permanent ? "failed" : "queued",
			analysis_attempts: attempts,
			analysis_error: msg,
		}).eq("id", broadcastId).eq("analysis_status", "running");
		return { broadcastId, status: permanent ? "failed" : "queued", error: msg };
	}
}
