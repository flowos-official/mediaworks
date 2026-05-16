import { getServiceClient } from "@/lib/supabase";
import { sleep } from "@/lib/broadcasts/fetch";
import { convertHlsToMp4AndUpload } from "@/lib/archive/video-pipeline";
import { slotVideoUrl } from "@/lib/shopch-products/slot-json-parser";

export interface BroadcastVideoArchiveResult {
	candidates: number;
	done: number;
	failed: number;
	skipped: number;
}

export interface BroadcastVideoArchiveOptions {
	/** Process at most N rows per run. Default 5 (videos are big — start small). */
	limit?: number;
	/** Only these dates (YYYY-MM-DD). Default: all pending. */
	onlyDates?: string[];
	/** "source" (default — stream-copy, no re-encode) or "720p". */
	videoQuality?: "720p" | "source";
	/** Sleep ms between rows. Default 5000 — be polite, these are huge fetches. */
	rowPauseMs?: number;
	onProgress?: (msg: string) => void;
}

interface BroadcastRow {
	id: string;
	channel: "shopch" | "qvc";
	air_date: string;
	start_time: string;
	video_status: string | null;
	video_download_attempts: number | null;
}

async function collectRows(
	opts: BroadcastVideoArchiveOptions,
): Promise<BroadcastRow[]> {
	const sb = getServiceClient();
	let q = sb
		.from("broadcasts")
		.select("id, channel, air_date, start_time, video_status, video_download_attempts")
		.eq("channel", "shopch")
		.or("video_status.is.null,video_status.eq.pending,video_status.eq.failed")
		.order("air_date", { ascending: false })
		.order("start_time", { ascending: true });
	if (opts.onlyDates && opts.onlyDates.length > 0) {
		q = q.in("air_date", opts.onlyDates);
	}
	q = q.limit(opts.limit ?? 5);
	const { data, error } = await q;
	if (error) throw new Error(`collectRows: ${error.message}`);
	return (data ?? []) as BroadcastRow[];
}

async function archiveOne(
	row: BroadcastRow,
	opts: BroadcastVideoArchiveOptions,
	onProgress: (msg: string) => void,
): Promise<"done" | "failed"> {
	const sb = getServiceClient();
	const slotKey = `${row.air_date.replace(/-/g, "")}${row.start_time.replace(/:/g, "")}`;
	const hlsUrl = slotVideoUrl(slotKey);
	const s3Key = `shopch/${slotKey}.mp4`;

	await sb
		.from("broadcasts")
		.update({
			video_status: "running",
			video_source_url: hlsUrl,
			video_download_attempts: (row.video_download_attempts ?? 0) + 1,
		})
		.eq("id", row.id);

	try {
		const t0 = Date.now();
		const result = await convertHlsToMp4AndUpload(hlsUrl, {
			key: s3Key,
			quality: opts.videoQuality ?? "source",
			onProgress: (line) => onProgress(`    ${line}`),
		});
		const secs = ((Date.now() - t0) / 1000).toFixed(1);
		onProgress(`  ok in ${secs}s — ${(result.upload.bytes / 1024 / 1024).toFixed(1)} MB`);

		await sb
			.from("broadcasts")
			.update({
				video_status: "done",
				archived_video_s3: result.upload.url,
				video_size_bytes: result.upload.bytes,
				video_duration_sec: result.duration_sec,
				video_quality: result.quality,
				video_downloaded_at: new Date().toISOString(),
				video_error: null,
			})
			.eq("id", row.id);
		return "done";
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		onProgress(`  failed: ${msg}`);
		await sb
			.from("broadcasts")
			.update({
				video_status: "failed",
				video_error: msg.slice(0, 500),
			})
			.eq("id", row.id);
		return "failed";
	}
}

export async function archiveBroadcastVideos(
	opts: BroadcastVideoArchiveOptions = {},
): Promise<BroadcastVideoArchiveResult> {
	const onProgress = opts.onProgress ?? (() => {});
	const pause = opts.rowPauseMs ?? 5000;

	const rows = await collectRows(opts);
	let done = 0;
	let failed = 0;
	const skipped = 0;

	onProgress(`Archiving ${rows.length} Shop Channel broadcast video(s)...`);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		onProgress(`[${i + 1}/${rows.length}] ${row.air_date} ${row.start_time}`);
		const r = await archiveOne(row, opts, onProgress);
		if (r === "done") done++;
		else failed++;
		if (i + 1 < rows.length) await sleep(pause);
	}

	return { candidates: rows.length, done, failed, skipped };
}
