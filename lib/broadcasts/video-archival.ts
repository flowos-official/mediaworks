/**
 * Single-slot video archival job. Given a queued broadcast row, resolves its
 * m3u8 source URL, pipes the stream through ffmpeg in copy mode (no transcode)
 * into an S3 multipart upload, and updates the broadcasts row with archive
 * metadata or a retryable failure state.
 *
 * Failure model: any throw rolls the slot back to `video_status='queued'`
 * with incremented attempts. At attempts >= MAX_ATTEMPTS the status becomes
 * `abandoned` and admin intervention is required.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { getServiceClient } from "@/lib/supabase";
import {
	createArchiveDeadline,
	killProcessOnAbort,
	runArchiveTransfer,
} from "./archive-deadline";
import { buildProgramId } from "./shopch-json";
import { resolveQvcVideoUrl } from "./qvc-video-resolver";
import { broadcastVideoKey, uploadStreamToS3 } from "./video-storage";

const MAX_ATTEMPTS = 5;

export interface QueuedSlot {
	id: string;
	channel: "qvc" | "shopch";
	air_date: string;
	start_time: string;
	product_ids: string[] | null;
	video_download_attempts: number;
}

export interface ArchiveResult {
	broadcastId: string;
	status: "archived" | "queued" | "deferred" | "abandoned" | "failed_unsupported";
	bytes?: number;
	error?: string;
}

/** Look up the m3u8 URL for the slot.
 *  QVC: per-PRODUCT digest clip on qvc_products.video_url. Scans ALL the slot's
 *    products (not just the lead one) via the shared resolver, so a slot whose
 *    lead product lacks a digest but a later product has one still archives.
 *  ShopCh: per-program video derived from programId (= air_date + start_time).
 *    Pattern confirmed against shop.jp on 2026-05-27 — public CloudFront,
 *    no auth/cookies/Referer required. */
async function resolveVideoUrl(slot: QueuedSlot, signal?: AbortSignal): Promise<string | null> {
	if (slot.channel === "qvc") {
		return resolveQvcVideoUrl(slot.product_ids, signal);
	}
	if (slot.channel === "shopch") {
		const programId = buildProgramId(slot.air_date, slot.start_time);
		return `https://www.shopch.jp/m3u8/prog/${programId}/${programId}_jwplayer.m3u8`;
	}
	return null;
}

/** Spawn ffmpeg to copy-mux the m3u8 into a fragmented MP4 on stdout.
 *  We use `-c copy` (no re-encode) and `-movflags frag_keyframe+empty_moov`
 *  so the MP4 stream is valid even when piped (no seekable index needed). */
function spawnFfmpegStream(m3u8Url: string, signal?: AbortSignal): {
	stream: Readable;
	stderrChunks: string[];
	wait: Promise<{ code: number | null }>;
} {
	const proc = spawn(ffmpegInstaller.path, [
		"-hide_banner",
		"-loglevel", "warning",
		"-i", m3u8Url,
		"-c", "copy",
		// HLS ships AAC as ADTS frames; MP4 container requires MPEG-4 AAC (ASC).
		// Without this filter ffmpeg exits 1 with "Malformed AAC bitstream".
		"-bsf:a", "aac_adtstoasc",
		"-movflags", "frag_keyframe+empty_moov",
		"-f", "mp4",
		"pipe:1",
	], { stdio: ["ignore", "pipe", "pipe"] });

	const stderrChunks: string[] = [];
	proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf-8")));
	const unbindAbort = signal ? killProcessOnAbort(signal, proc) : undefined;
	const wait = new Promise<{ code: number | null }>((resolve) => {
		proc.on("close", (code) => {
			unbindAbort?.();
			resolve({ code });
		});
	});
	return { stream: proc.stdout, stderrChunks, wait };
}

export interface ArchiveOptions {
	/** Absolute Date.now()-scale deadline. Omit for unbounded local drains. */
	deadlineMs?: number;
	/** Route-wide work signal, active before claim/resolution as well as transfer. */
	signal?: AbortSignal;
	/** Longer-lived signal reserved for DB finalization/rollback after work aborts. */
	cleanupSignal?: AbortSignal;
}

/** Archive one queued slot. Idempotent: a row already 'archived' is a no-op.
 *  Failures roll the status forward correctly. */
export async function archiveOne(
	slot: QueuedSlot,
	options: ArchiveOptions = {},
): Promise<ArchiveResult> {
	const sb = getServiceClient();
	const broadcastId = slot.id;
	if (options.signal?.aborted || (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)) {
		return { broadcastId, status: "queued", error: "archive deadline elapsed before claim" };
	}
	const cleanupSignal = options.cleanupSignal ?? options.signal;

	// Claim the slot so a parallel cron run doesn't double-process it.
	let claimQuery = sb
		.from("broadcasts")
		.update({ video_status: "downloading" })
		.eq("id", broadcastId)
		.eq("video_status", "queued")
		.select("id");
	if (options.signal) claimQuery = claimQuery.abortSignal(options.signal);
	const { data: claimed, error: claimErr } = await claimQuery;
	if (claimErr) {
		return { broadcastId, status: "queued", error: claimErr.message };
	}
	if (!claimed || claimed.length === 0) {
		return {
			broadcastId,
			status: "queued",
			error: "claim lost: slot was no longer queued",
		};
	}

	// resolveVideoUrl can throw on a transient DB error (it must NOT silently
	// read that as "no video"). Roll the claimed slot back to 'queued' so the
	// next drain retries — never strand it in 'downloading' or wrongly defer it.
	let videoUrl: string | null;
	try {
		videoUrl = await resolveVideoUrl(slot, options.signal);
	} catch (e) {
		const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
		let rollbackQuery = sb.from("broadcasts")
			.update({ video_status: "queued", video_error: msg })
			.eq("id", broadcastId).eq("video_status", "downloading").select("id");
		if (cleanupSignal) rollbackQuery = rollbackQuery.abortSignal(cleanupSignal);
		const { data: rolledBack, error: rollbackError } = await rollbackQuery;
		if (rollbackError) {
			return { broadcastId, status: "queued", error: `${msg}; rollback failed: ${rollbackError.message}`.slice(0, 500) };
		}
		if (!rolledBack || rolledBack.length === 0) {
			return { broadcastId, status: "queued", error: `${msg}; rollback skipped: slot was no longer downloading`.slice(0, 500) };
		}
		return { broadcastId, status: "queued", error: msg };
	}
	if (!videoUrl) {
		let deferQuery = sb.from("broadcasts").update({
			video_status: "deferred",
			video_error: "no video_url for any product",
		}).eq("id", broadcastId).eq("video_status", "downloading").select("id");
		if (cleanupSignal) deferQuery = deferQuery.abortSignal(cleanupSignal);
		const { data: updated, error: updateErr } = await deferQuery;
		if (updateErr) {
			return { broadcastId, status: "queued", error: updateErr.message };
		}
		if (!updated || updated.length === 0) {
			return {
				broadcastId,
				status: "queued",
				error: "defer skipped: slot was no longer downloading",
			};
		}
		return { broadcastId, status: "deferred" };
	}

	const key = broadcastVideoKey(slot.channel, slot.air_date, slot.start_time, broadcastId);
	if (options.signal?.aborted || (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)) {
		let rollbackQuery = sb.from("broadcasts")
			.update({ video_status: "queued", video_error: "archive deadline elapsed before transfer" })
			.eq("id", broadcastId).eq("video_status", "downloading").select("id");
		if (cleanupSignal) rollbackQuery = rollbackQuery.abortSignal(cleanupSignal);
		const { data: rolledBack, error: rollbackError } = await rollbackQuery;
		if (rollbackError) {
			return { broadcastId, status: "queued", error: `archive deadline elapsed before transfer; rollback failed: ${rollbackError.message}`.slice(0, 500) };
		}
		if (!rolledBack || rolledBack.length === 0) {
			return { broadcastId, status: "queued", error: "archive deadline elapsed before transfer; rollback skipped: slot was no longer downloading" };
		}
		return { broadcastId, status: "queued", error: "archive deadline elapsed before transfer" };
	}
	const deadline = options.signal || options.deadlineMs === undefined
		? undefined
		: createArchiveDeadline(options.deadlineMs);
	const workSignal = options.signal ?? deadline?.signal;
	let stderrChunks: string[] = [];

	try {
		const [{ bytes }] = await runArchiveTransfer(workSignal, (transferSignal) => {
			const ffmpeg = spawnFfmpegStream(videoUrl, transferSignal);
			stderrChunks = ffmpeg.stderrChunks;
			return {
				upload: uploadStreamToS3(ffmpeg.stream, key, "video/mp4", transferSignal),
				ffmpeg: ffmpeg.wait.then(({ code }) => {
					if (code !== 0) {
						throw new Error(`ffmpeg exited with code ${code}: ${stderrChunks.join("").slice(-500)}`);
					}
					return code;
				}),
			};
		});
		// ffmpeg writes a Duration line to stderr around stream start.
		const durationSec = parseDurationFromStderr(stderrChunks.join(""));
		let finalizeQuery = sb.from("broadcasts").update({
			archived_video_s3: key,
			video_size_bytes: bytes,
			video_duration_sec: durationSec,
			video_quality: "source",
			video_status: "archived",
			video_downloaded_at: new Date().toISOString(),
			video_error: null,
		}).eq("id", broadcastId).eq("video_status", "downloading").select("id");
		if (cleanupSignal) finalizeQuery = finalizeQuery.abortSignal(cleanupSignal);
		const { data: updated, error: updateErr } = await finalizeQuery;
		if (updateErr) {
			return { broadcastId, status: "queued", bytes, error: updateErr.message };
		}
		if (!updated || updated.length === 0) {
			return {
				broadcastId,
				status: "queued",
				bytes,
				error: "archive finalization skipped: slot was no longer downloading",
			};
		}
		return { broadcastId, status: "archived", bytes };
	} catch (e) {
		const msg = (
			workSignal?.aborted
				? "archive deadline exceeded"
				: e instanceof Error ? e.message : String(e)
		).slice(0, 500);
		// ShopCh's per-program m3u8 publishes only AFTER the program airs; a 403
		// means the CloudFront object doesn't exist yet (not-yet-aired or publish
		// lag), NOT a real failure. Roll back to 'deferred' WITHOUT consuming an
		// attempt so the recovery sweep re-queues it once the video goes live —
		// otherwise a slot queued too early burns all 5 attempts on 403s and is
		// wrongly abandoned.
		if (slot.channel === "shopch" && /403 Forbidden/i.test(msg)) {
			let deferQuery = sb.from("broadcasts").update({
				video_status: "deferred",
				video_error: msg,
			}).eq("id", broadcastId).eq("video_status", "downloading").select("id");
			if (cleanupSignal) deferQuery = deferQuery.abortSignal(cleanupSignal);
			const { data: updated, error: updateErr } = await deferQuery;
			if (updateErr) {
				return { broadcastId, status: "queued", error: updateErr.message };
			}
			if (!updated || updated.length === 0) {
				return {
					broadcastId,
					status: "queued",
					error: "403 defer skipped: slot was no longer downloading",
				};
			}
			return { broadcastId, status: "deferred", error: msg };
		}
		const attempts = (slot.video_download_attempts ?? 0) + 1;
		const finalStatus = attempts >= MAX_ATTEMPTS ? "abandoned" : "queued";
		let failureQuery = sb.from("broadcasts").update({
			video_status: finalStatus,
			video_download_attempts: attempts,
			video_error: msg,
		}).eq("id", broadcastId).eq("video_status", "downloading").select("id");
		if (cleanupSignal) failureQuery = failureQuery.abortSignal(cleanupSignal);
		const { data: updated, error: updateErr } = await failureQuery;
		if (updateErr) {
			return { broadcastId, status: "queued", error: updateErr.message };
		}
		if (!updated || updated.length === 0) {
			return {
				broadcastId,
				status: "queued",
				error: "failure update skipped: slot was no longer downloading",
			};
		}
		return { broadcastId, status: finalStatus, error: msg };
	} finally {
		deadline?.dispose();
	}
}

/** Parse `Duration: HH:MM:SS.xx` from ffmpeg stderr. Returns null when not
 *  found (e.g. the stream finished too fast or the format hid it). */
export function parseDurationFromStderr(stderr: string): number | null {
	const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	if (!m) return null;
	const h = parseInt(m[1], 10);
	const mi = parseInt(m[2], 10);
	const s = parseFloat(m[3]);
	if (!Number.isFinite(h + mi + s)) return null;
	return Math.round(h * 3600 + mi * 60 + s);
}
