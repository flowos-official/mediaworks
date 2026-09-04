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
/**
 * Which path reads the archived MP4.
 *
 * `cdn` (default) fetches the public CloudFront URL — the same path playback
 * uses. `s3` reads the bucket directly with GetObject.
 *
 * The default is deliberately NOT `s3`, because the cheaper path depends
 * entirely on where this runs. The bucket is in ap-northeast-2:
 *
 *   in-region (an EC2 box in ap-northeast-2)  S3 GetObject   $0/GB
 *   anywhere else (Vercel, a laptop)          S3 GetObject   ~$0.126/GB
 *                                             CloudFront     ~$0.114/GB
 *
 * So the cron, which runs on Vercel, must keep using the CDN — switching it to
 * S3 would make every run more expensive, not less. Set
 * `BROADCAST_INTEL_READ_VIA=s3` only where the reader shares the bucket's
 * region, which is the whole point: a 3 TB ShopCh drain costs ~$345 of egress
 * from a laptop and nothing at all from a Seoul instance.
 *
 * (The older comment here said the archiver identity had PutObject but no
 * GetObject. That is no longer true — the grant exists, verified 2026-09-02 by
 * a ranged GetObject — so the CDN is now a cost choice rather than a
 * permissions workaround.)
 */
const READ_VIA = (process.env.BROADCAST_INTEL_READ_VIA ?? "cdn").trim().toLowerCase();

async function readViaCdn(base: string, s3Key: string, remaining: number): Promise<Readable> {
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
	return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
}

async function readViaS3(s3Key: string, remaining: number): Promise<Readable> {
	const { GetObjectCommand } = await import("@aws-sdk/client-s3");
	const { getVideoStorageClient } = await import("@/lib/broadcasts/video-storage");
	const bucket = process.env.VIDEO_ARCHIVE_AWS_BUCKET;
	if (!bucket) throw new Error("Missing required env var: VIDEO_ARCHIVE_AWS_BUCKET");

	let res;
	try {
		res = await getVideoStorageClient().send(
			new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
			{ abortSignal: AbortSignal.timeout(remaining) },
		);
	} catch (err) {
		const name = err instanceof Error ? err.name : "";
		// Same split as the CDN path: absent is permanent, denied is not — a cold
		// object that has not finished restoring answers InvalidObjectState, and
		// that clears on its own.
		if (name === "NoSuchKey" || name === "NotFound") {
			throw new NonRetryableAudioError(`archive object not readable (${name}) for ${s3Key}`);
		}
		throw err;
	}
	if (!res.Body) throw new NonRetryableAudioError(`archive response has no body: ${s3Key}`);
	return res.Body as Readable;
}

/**
 * Cut already-extracted audio into `chunkSec` pieces.
 *
 * Operates on the extracted AAC, not the source MP4: the expensive part is
 * pulling the ~1.2 GB archive object, and that has already happened by the time
 * this runs. Re-reading the source once per chunk would multiply the only leg
 * of this pipeline that costs real money.
 *
 * `-c copy` keeps it to a demux/remux of a ~30 MB buffer with no re-encode, so
 * the whole split is a fraction of a second. ADTS carries no container index,
 * which is why the pieces come back through a temp directory rather than a
 * pipe: the segment muxer needs a seekable output per piece.
 */
export async function splitAudio(
	audio: Buffer,
	durationSec: number,
	chunkSec: number,
): Promise<Array<{ audio: Buffer; offsetSec: number; durationSec: number }>> {
	if (chunkSec <= 0) throw new Error(`splitAudio: chunkSec must be positive, got ${chunkSec}`);
	if (durationSec <= chunkSec) {
		return [{ audio, offsetSec: 0, durationSec }];
	}

	const { mkdtemp, writeFile, readFile, readdir, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const dir = await mkdtemp(join(tmpdir(), "bi-chunk-"));
	try {
		const input = join(dir, "in.aac");
		await writeFile(input, audio);

		await new Promise<void>((resolve, reject) => {
			const proc = spawn(ffmpegInstaller.path, [
				"-hide_banner", "-loglevel", "error",
				"-i", input,
				"-f", "segment",
				"-segment_time", String(chunkSec),
				"-c", "copy",
				join(dir, "part%04d.aac"),
			]);
			let err = "";
			proc.stderr.on("data", (c: Buffer) => { err = (err + c.toString("utf-8")).slice(-4096); });
			proc.on("error", (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
			proc.on("close", (code) =>
				code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${err.slice(-500)}`)),
			);
		});

		const names = (await readdir(dir)).filter((n) => n.startsWith("part")).sort();
		if (names.length === 0) throw new Error("splitAudio produced no chunks");

		const parts = await Promise.all(names.map((n) => readFile(join(dir, n))));
		return parts.map((buf, i) => {
			const offsetSec = i * chunkSec;
			// The last piece runs to the real end, which is shorter than chunkSec.
			// Its length is what the model is told, and what bounds its timecodes.
			return { audio: buf, offsetSec, durationSec: Math.min(chunkSec, durationSec - offsetSec) };
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

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

	const source = READ_VIA === "s3"
		? await readViaS3(s3Key, remaining)
		: await readViaCdn(base, s3Key, remaining);

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
