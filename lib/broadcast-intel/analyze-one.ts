/**
 * Single-slot analysis job, modelled on lib/broadcasts/video-archival.ts.
 *
 * Failure model: a retryable throw rolls the slot back to `queued` with an
 * incremented attempt count; NonRetryableAudioError pins it to `failed`
 * immediately, because repeating it means re-downloading 606 MB for the same
 * outcome. At attempts >= MAX_ATTEMPTS the slot becomes `failed`.
 */
import { getServiceClient } from "@/lib/supabase";
import { extractAudio, NonRetryableAudioError, classifyAudioError, SLOT_TIMEOUT_MS } from "./audio-extract";
import { analyzeAudio, classifyGeminiError } from "./gemini-analyze";
import { persistAnalysis } from "./persist";
import type { AnalysisErrorCode } from "./error-codes";

/** Combines both modules' classifiers; analyze-one.ts is the only place that
 *  sees failures from the whole slot, so it owns the final fallback. */
function classifyAnalysisError(e: unknown): AnalysisErrorCode {
	// Literal authored by this module, so matching it can never echo content.
	if (e instanceof Error && e.message.startsWith("act coverage too low")) return "low_coverage";
	return classifyAudioError(e) ?? classifyGeminiError(e) ?? "unknown";
}

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

/** Minimum share of the runtime the act breakdown must span.
 *
 *  Both first probes stopped at 77-80% and labelled that point `closing`, so
 *  nothing in the output said the tail had been dropped — the aggregate would
 *  have divided every act's length by a runtime a fifth longer than what was
 *  actually read, and on a 59-minute ShopCh programme the closing CTA was lost
 *  entirely. Telling the model the exact runtime fixed it (both now reach
 *  100%), but a silent regression here corrupts the corpus rather than
 *  breaking it, so it is worth an explicit gate. Retryable: this is model
 *  variance, and a fresh attempt may well cover the whole file. */
const MIN_ACT_COVERAGE = 0.9;

export function assertActCoverage(
	segments: Array<{ startSec: number; endSec: number }>,
	durationSec: number,
): void {
	const lastEnd = segments.reduce((max, s) => Math.max(max, s.endSec), 0);
	if (lastEnd < durationSec * MIN_ACT_COVERAGE) {
		throw new Error(
			`act coverage too low: acts end at ${Math.round(lastEnd)}s of ${durationSec}s ` +
				`(${Math.round((100 * lastEnd) / durationSec)}%, need ${Math.round(MIN_ACT_COVERAGE * 100)}%)`,
		);
	}
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
		const code: AnalysisErrorCode = !slot.archived_video_s3 ? "no_archived_video" : "no_category";
		await sb.from("broadcasts")
			.update({ analysis_status: "skipped", analysis_error: code })
			.eq("id", broadcastId).eq("analysis_status", "running");
		return { broadcastId, status: "skipped", error: code };
	}

	try {
		// ONE deadline for the whole slot — threaded through both legs so a
		// pathological slot is bounded by SLOT_TIMEOUT_MS total (200s default),
		// not 2x that from each leg getting its own independent ceiling.
		const deadline = Date.now() + SLOT_TIMEOUT_MS;
		const { audio, durationSec } = await extractAudio(slot.archived_video_s3, deadline);
		const { analysis, model } = await analyzeAudio(audio, durationSec, deadline);
		assertActCoverage(analysis.patterns.segments, durationSec);

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
		// The full message is for operators only (function logs / local drain
		// terminal) — it can contain a verbatim snippet of competitor dialogue
		// (see error-codes.ts). It must never reach `analysis_error`, which is
		// anon-readable.
		const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
		const code = classifyAnalysisError(e);
		console.error(`[broadcast-intel] analyzeOne(${broadcastId}) failed [${code}]:`, e);
		const attempts = (slot.analysis_attempts ?? 0) + 1;
		const permanent = e instanceof NonRetryableAudioError || attempts >= MAX_ATTEMPTS;
		await sb.from("broadcasts").update({
			analysis_status: permanent ? "failed" : "queued",
			analysis_attempts: attempts,
			analysis_error: code,
		}).eq("id", broadcastId).eq("analysis_status", "running");
		return { broadcastId, status: permanent ? "failed" : "queued", error: msg };
	}
}
