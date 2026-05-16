import { spawn } from "node:child_process";
import { readFile, stat, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadBytes, type UploadResult } from "./upload";

export type VideoQuality = "720p" | "source";

export interface VideoPipelineResult {
	upload: UploadResult;
	duration_sec: number;
	width: number | null;
	height: number | null;
	bit_rate: number | null;
	quality: VideoQuality;
}

export interface VideoPipelineOptions {
	/** Output key inside the videos bucket, e.g. `qvc/749808.mp4`. */
	key: string;
	/** "source" stream-copies the original codec (no re-encode, default).
	 *  "720p" re-encodes to H.264 1500 kbps + AAC 128 kbps when explicit downscale is needed. */
	quality?: VideoQuality;
	/** Path to ffmpeg binary. Default: "ffmpeg" (PATH). */
	ffmpegBin?: string;
	/** Path to ffprobe binary. Default: "ffprobe" (PATH). */
	ffprobeBin?: string;
	/** Logger for progress lines. Default: no-op. */
	onProgress?: (msg: string) => void;
}

function runCmd(
	bin: string,
	args: string[],
	onLine: (line: string) => void,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderrBuf = "";
		proc.stderr.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString();
			let idx: number;
			while ((idx = stderrBuf.indexOf("\n")) !== -1) {
				onLine(stderrBuf.slice(0, idx));
				stderrBuf = stderrBuf.slice(idx + 1);
			}
		});
		proc.on("error", reject);
		proc.on("close", (code) => resolve(code ?? -1));
	});
}

async function probe(
	file: string,
	ffprobeBin: string,
): Promise<{
	duration_sec: number;
	width: number | null;
	height: number | null;
	bit_rate: number | null;
}> {
	const proc = spawn(ffprobeBin, [
		"-v", "error",
		"-show_entries", "format=duration,bit_rate",
		"-show_entries", "stream=codec_type,width,height",
		"-of", "default=noprint_wrappers=1",
		file,
	]);
	let out = "";
	proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
	const code: number = await new Promise((res, rej) => {
		proc.on("close", (c) => res(c ?? -1));
		proc.on("error", rej);
	});
	if (code !== 0) {
		return { duration_sec: 0, width: null, height: null, bit_rate: null };
	}
	const get = (key: string) => {
		const m = out.match(new RegExp(`${key}=([0-9.]+)`));
		return m ? Number(m[1]) : null;
	};
	// Width/height appear under each stream — pick the first video stream.
	const videoBlock = out.match(/codec_type=video[\s\S]*?(?=codec_type=|$)/)?.[0] ?? "";
	const w = videoBlock.match(/width=(\d+)/)?.[1];
	const h = videoBlock.match(/height=(\d+)/)?.[1];
	return {
		duration_sec: get("duration") ?? 0,
		width: w ? Number(w) : null,
		height: h ? Number(h) : null,
		bit_rate: get("bit_rate"),
	};
}

/**
 * Convert an HLS (m3u8) source to MP4 and upload to S3.
 *
 *   - `quality: "720p"` (default) — re-encodes video to 720p H.264 ~1.5 Mbps,
 *     audio to AAC 128 kbps. Used for archival + Gemini analysis.
 *   - `quality: "source"` — stream-copies the original codec/bitrate. Fastest
 *     and lossless but file is larger.
 *
 * Returns the S3 upload result + probed metadata.
 */
export async function convertHlsToMp4AndUpload(
	hlsUrl: string,
	opts: VideoPipelineOptions,
): Promise<VideoPipelineResult> {
	const quality = opts.quality ?? "source";
	const ffmpegBin = opts.ffmpegBin ?? "ffmpeg";
	const ffprobeBin = opts.ffprobeBin ?? "ffprobe";
	const onProgress = opts.onProgress ?? (() => {});

	const workDir = path.join(tmpdir(), "mediaworks-video", String(Date.now()));
	await mkdir(workDir, { recursive: true });
	const outFile = path.join(workDir, "out.mp4");

	const args =
		quality === "720p"
			? [
					"-y",
					"-loglevel", "error",
					"-i", hlsUrl,
					"-vf", "scale=-2:720",
					"-c:v", "libx264",
					"-preset", "veryfast",
					"-b:v", "1500k",
					"-maxrate", "1800k",
					"-bufsize", "3000k",
					"-c:a", "aac",
					"-b:a", "128k",
					"-movflags", "+faststart",
					outFile,
			  ]
			: [
					"-y",
					"-loglevel", "error",
					"-i", hlsUrl,
					"-c", "copy",
					"-bsf:a", "aac_adtstoasc",
					"-movflags", "+faststart",
					outFile,
			  ];

	const code = await runCmd(ffmpegBin, args, onProgress);
	if (code !== 0) {
		await unlink(outFile).catch(() => undefined);
		throw new Error(`ffmpeg exited with code ${code}`);
	}

	const probed = await probe(outFile, ffprobeBin);
	const st = await stat(outFile);
	const bytes = await readFile(outFile);
	await unlink(outFile).catch(() => undefined);

	const upload = await uploadBytes("videos", opts.key, bytes, {
		contentType: "video/mp4",
		cacheControl: "public, max-age=31536000, immutable",
	});

	return {
		upload,
		duration_sec: Math.round(probed.duration_sec),
		width: probed.width,
		height: probed.height,
		bit_rate: probed.bit_rate,
		quality,
	};
}

/** Sanity check: is ffmpeg on PATH? Cheap startup probe. */
export async function checkFfmpegAvailable(bin = "ffmpeg"): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			const proc = spawn(bin, ["-version"]);
			proc.on("error", () => resolve(false));
			proc.on("close", (code) => resolve(code === 0));
		} catch {
			resolve(false);
		}
	});
}
