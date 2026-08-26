/**
 * Archived MP4 (read via the CloudFront distribution) → mono 16 kHz ADTS AAC
 * + the real runtime.
 *
 * Runtime: the archive is written with `-movflags frag_keyframe+empty_moov`
 * (lib/broadcasts/video-archival.ts), so the stored MP4 carries no duration in
 * its moov. Re-reading it from a non-seekable pipe makes ffmpeg report the
 * PROBE WINDOW as the duration — measured 00:00:50.02 for a 600 s file. The
 * only trustworthy source is the last `time=` in the progress output, which is
 * what was actually demuxed. Do NOT reuse video-archival's
 * parseDurationFromStderr here.
 *
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import type { AnalysisErrorCode } from "./error-codes";

export const AUDIO_MIME = "audio/aac";

/** Single ceiling shared by BOTH legs of a slot (this ffmpeg extraction and
 *  gemini-analyze.ts's Gemini leg) — analyzeOne computes ONE deadline from
 *  this and threads it through both calls, so a pathological slot is bounded
 *  by SLOT_TIMEOUT_MS total, not per-leg. Exported so gemini-analyze.ts
 *  shares the exact same default rather than re-parsing the env var. */
export const SLOT_TIMEOUT_MS = Number(process.env.BROADCAST_INTEL_SLOT_TIMEOUT_MS) || 200_000;
const STDERR_TAIL_BYTES = 64 * 1024;

/** Thrown for failures that repeating cannot fix. The caller marks the slot
 *  `failed` immediately rather than re-downloading 606 MB two more times. */
export class NonRetryableAudioError extends Error {}

/**
 * Maps a thrown error from this module's own throw sites to a DB-safe code.
 * Returns null for anything it doesn't recognize (including the MAX_TOKENS
 * NonRetryableAudioError raised by gemini-analyze.ts, which is not this
 * module's concern) so the caller can fall through to the next classifier.
 * Every comparison here is against a literal string this module itself
 * authored — never a substring of external input — so classification can
 * never leak content.
 */
export function classifyAudioError(e: unknown): AnalysisErrorCode | null {
	if (e instanceof NonRetryableAudioError) {
		if (e.message.startsWith("archive object not readable")) return "s3_fetch_failed";
		if (e.message.startsWith("archive response has no body")) return "s3_fetch_failed";
		if (e.message.startsWith("no progress output")) return "runtime_unknown";
		return null;
	}
	if (e instanceof Error) {
		if (e.message.startsWith("Missing required env var")) return "config_error";
		if (e.message.startsWith("archive fetch failed with HTTP")) return "s3_fetch_failed";
		if (e.name === "TimeoutError") return "s3_fetch_failed";
		if (e.message.startsWith("ffmpeg failed to start")) return "ffmpeg_failed";
		if (e.message.startsWith("ffmpeg exited with code")) return "ffmpeg_failed";
		if (e.message.startsWith("audio extraction deadline")) return "ffmpeg_failed";
	}
	return null;
}

/** Mono 16 kHz AAC is the smallest form Gemini still transcribes reliably.
 *  A 25-minute slot lands around 6 MB, against 606 MB for the source. */
export function buildAudioFfmpegArgs(): string[] {
	return [
		"-hide_banner",
		"-loglevel", "info",   // progress lines carry the only reliable runtime
		"-i", "pipe:0",
		"-vn",
		"-ac", "1",
		"-ar", "16000",
		"-c:a", "aac",
		"-b:a", "32k",
		"-f", "adts",
		"pipe:1",
	];
}

/** Last `time=HH:MM:SS.xx` in ffmpeg's progress output = what was demuxed. */
export function parseOutputDurationFromStderr(stderr: string): number | null {
	const re = /time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g;
	let last: RegExpExecArray | null = null;
	for (let m = re.exec(stderr); m; m = re.exec(stderr)) last = m;
	if (!last) return null;
	const sec = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
	return sec > 0 ? Math.round(sec) : null;
}

/**
 * `deadline` is an absolute Date.now()-scale timestamp, not a duration — the
 * caller (analyzeOne) computes ONE deadline and passes the same value to
 * both this function and analyzeAudio, so the ffmpeg leg and the Gemini leg
 * share a single SLOT_TIMEOUT_MS budget instead of each getting their own.
 * Defaults to a fresh SLOT_TIMEOUT_MS-out deadline so this stays callable
 * standalone (tests, the live smoke script).
 */
export async function extractAudio(
	s3Key: string,
	deadline: number = Date.now() + SLOT_TIMEOUT_MS,
): Promise<{ audio: Buffer; durationSec: number }> {
	const base =
		process.env.VIDEO_ARCHIVE_BASE_URL ?? process.env.NEXT_PUBLIC_VIDEO_ARCHIVE_BASE_URL;
	if (!base) throw new Error("Missing required env var: VIDEO_ARCHIVE_BASE_URL");
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		throw new Error(`audio extraction deadline already elapsed before extraction started for ${s3Key}`);
	}

	// Read through the public CloudFront distribution rather than S3 GetObject.
	// The archiver IAM user has PutObject but no GetObject — nothing had ever
	// needed to read these back, because playback already goes through the CDN
	// (BroadcastVideoModal builds the same URL). Using the CDN keeps this
	// pipeline on the same read path as the rest of the app, avoids widening
	// that IAM policy, and serves from an edge cache instead of the bucket.
	const url = `${base.replace(/\/+$/, "")}/${s3Key}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(remaining) });
	if (res.status === 404) {
		// Genuinely absent. Retrying re-spends the request for the same answer.
		throw new NonRetryableAudioError(`archive object not readable (HTTP 404) for ${s3Key}`);
	}
	// 403 is NOT permanent here, despite CLAUDE.md's "a 403 means the object
	// doesn't exist" — that note describes ShopCh's SOURCE m3u8, not our own
	// distribution. Measured: a drain slot failed with 403, and the identical
	// URL then returned 200 on five sequential and five concurrent HEADs
	// (1.23 GB, cache miss then hits). Treating it as permanent pinned a
	// healthy slot to `failed` after one attempt.
	if (!res.ok) throw new Error(`archive fetch failed with HTTP ${res.status} for ${s3Key}`);
	if (!res.body) throw new NonRetryableAudioError(`archive response has no body: ${s3Key}`);
	const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);

	const proc = spawn(ffmpegInstaller.path, buildAudioFfmpegArgs(), {
		stdio: ["pipe", "pipe", "pipe"],
	});

	// Ring-buffer stderr: a 25-minute transcode emits progress continuously and
	// we only ever need the tail.
	let stderr = "";
	proc.stderr.on("data", (c: Buffer) => {
		stderr = (stderr + c.toString("utf-8")).slice(-STDERR_TAIL_BYTES);
	});

	const audioChunks: Buffer[] = [];
	proc.stdout.on("data", (c: Buffer) => audioChunks.push(c));

	let spawnError: Error | undefined;
	proc.on("error", (err: Error) => { spawnError = err; });

	const killTimer = setTimeout(() => proc.kill("SIGKILL"), Math.max(0, deadline - Date.now()));
	source.on("error", () => proc.kill("SIGKILL"));
	proc.stdin.on("error", () => {});   // EPIPE when ffmpeg exits early
	source.pipe(proc.stdin);

	try {
		// 'close' fires only after stdout and stderr have both closed, so no
		// output can still be in flight here.
		const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
		if (spawnError) throw new Error(`ffmpeg failed to start: ${spawnError.message}`);
		if (code !== 0) throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`);

		const durationSec = parseOutputDurationFromStderr(stderr);
		if (durationSec === null) {
			// Deterministic: retrying re-downloads the object for the same result.
			throw new NonRetryableAudioError(`no progress output; runtime unknown for ${s3Key}`);
		}
		return { audio: Buffer.concat(audioChunks), durationSec };
	} finally {
		clearTimeout(killTimer);
	}
}
