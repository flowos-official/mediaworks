/**
 * Single-slot video archival job. Given a queued broadcast row, resolves its
 * m3u8 source URL (QVC only at this stage), pipes the stream through ffmpeg
 * in copy mode (no transcode) into an R2 multipart upload, and updates the
 * broadcasts row with archive metadata or a retryable failure state.
 *
 * Failure model: any throw rolls the slot back to `video_status='queued'`
 * with incremented attempts. At attempts >= MAX_ATTEMPTS the status becomes
 * `abandoned` and admin intervention is required.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { getServiceClient } from "@/lib/supabase";
import { broadcastVideoKey, uploadStreamToR2 } from "./r2-storage";

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

/** Look up the m3u8 URL for the slot's lead product. ShopCh is deferred. */
async function resolveVideoUrl(slot: QueuedSlot): Promise<string | null> {
	if (slot.channel !== "qvc") return null;
	const firstPid = slot.product_ids?.[0];
	if (!firstPid) return null;
	const sb = getServiceClient();
	const { data } = await sb
		.from("qvc_products")
		.select("video_url")
		.eq("id", firstPid)
		.maybeSingle();
	const url = (data as { video_url: string | null } | null)?.video_url ?? null;
	if (!url) return null;
	return url.startsWith("http") ? url : `https:${url}`;
}

/** Spawn ffmpeg to copy-mux the m3u8 into a fragmented MP4 on stdout.
 *  We use `-c copy` (no re-encode) and `-movflags frag_keyframe+empty_moov`
 *  so the MP4 stream is valid even when piped (no seekable index needed). */
function spawnFfmpegStream(m3u8Url: string): {
	stream: Readable;
	stderrChunks: string[];
	wait: Promise<{ code: number | null }>;
} {
	const proc = spawn(ffmpegInstaller.path, [
		"-hide_banner",
		"-loglevel", "warning",
		"-i", m3u8Url,
		"-c", "copy",
		"-movflags", "frag_keyframe+empty_moov",
		"-f", "mp4",
		"pipe:1",
	], { stdio: ["ignore", "pipe", "pipe"] });

	const stderrChunks: string[] = [];
	proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf-8")));
	const wait = new Promise<{ code: number | null }>((resolve) => {
		proc.on("close", (code) => resolve({ code }));
	});
	return { stream: proc.stdout, stderrChunks, wait };
}

/** Archive one queued slot. Idempotent: a row already 'archived' is a no-op.
 *  Failures roll the status forward correctly. */
export async function archiveOne(slot: QueuedSlot): Promise<ArchiveResult> {
	const sb = getServiceClient();
	const broadcastId = slot.id;

	// Claim the slot so a parallel cron run doesn't double-process it.
	const { error: claimErr } = await sb
		.from("broadcasts")
		.update({ video_status: "downloading" })
		.eq("id", broadcastId)
		.eq("video_status", "queued");
	if (claimErr) {
		return { broadcastId, status: "queued", error: claimErr.message };
	}

	const videoUrl = await resolveVideoUrl(slot);
	if (!videoUrl) {
		await sb.from("broadcasts").update({
			video_status: slot.channel === "shopch" ? "failed_unsupported" : "deferred",
			video_error: slot.channel === "shopch"
				? "shopch video archival not yet supported"
				: "no video_url for lead product",
		}).eq("id", broadcastId);
		return { broadcastId, status: slot.channel === "shopch" ? "failed_unsupported" : "deferred" };
	}

	const key = broadcastVideoKey(slot.channel, slot.air_date, slot.start_time, broadcastId);
	const { stream, stderrChunks, wait } = spawnFfmpegStream(videoUrl);

	try {
		const [{ bytes }, { code }] = await Promise.all([
			uploadStreamToR2(stream, key),
			wait,
		]);
		if (code !== 0) {
			throw new Error(`ffmpeg exited with code ${code}: ${stderrChunks.join("").slice(-500)}`);
		}
		// ffmpeg writes a Duration line to stderr around stream start.
		const durationSec = parseDurationFromStderr(stderrChunks.join(""));
		await sb.from("broadcasts").update({
			archived_video_s3: key,
			video_size_bytes: bytes,
			video_duration_sec: durationSec,
			video_quality: "source",
			video_status: "archived",
			video_downloaded_at: new Date().toISOString(),
			video_error: null,
		}).eq("id", broadcastId);
		return { broadcastId, status: "archived", bytes };
	} catch (e) {
		const attempts = (slot.video_download_attempts ?? 0) + 1;
		const finalStatus = attempts >= MAX_ATTEMPTS ? "abandoned" : "queued";
		const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
		await sb.from("broadcasts").update({
			video_status: finalStatus,
			video_download_attempts: attempts,
			video_error: msg,
		}).eq("id", broadcastId);
		return { broadcastId, status: finalStatus, error: msg };
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
