import { getServiceClient } from "@/lib/supabase";
import { sleep } from "@/lib/broadcasts/fetch";
import { snapshotHtml } from "@/lib/archive/html-snapshot";
import { downloadAndUploadImages } from "@/lib/archive/image-downloader";
import { convertHlsToMp4AndUpload } from "@/lib/archive/video-pipeline";
import { fetchAndStoreQvcReviews } from "./reviews";

export interface ArchiveQvcResult {
	candidates: number;
	completed: number;
	partial: number;
	failed: number;
}

export interface ArchiveQvcOptions {
	/** Process at most N rows. Default unlimited. */
	limit?: number;
	/** Re-archive rows older than this many hours. Default 24×30 = 30 days. */
	staleHours?: number;
	/** Sleep ms between rows for politeness. Default 1500. */
	rowPauseMs?: number;
	/** Skip video step (images + HTML only). Default false. */
	skipVideo?: boolean;
	/** "source" (default — stream-copy, no re-encode) or "720p". */
	videoQuality?: "720p" | "source";
	onProgress?: (msg: string) => void;
}

interface QvcRow {
	id: string;
	source_url: string;
	image_urls: string[] | null;
	video_url: string | null;
	archive_status: string | null;
	first_archived_at: string | null;
}

async function collectRows(opts: ArchiveQvcOptions): Promise<QvcRow[]> {
	const sb = getServiceClient();
	const staleHours = opts.staleHours ?? 24 * 30;
	const cutoff = new Date(Date.now() - staleHours * 3600_000).toISOString();

	const { data, error } = await sb
		.from("qvc_products")
		.select("id, source_url, image_urls, video_url, archive_status, first_archived_at")
		.or(
			[
				"archive_status.is.null",
				"archive_status.eq.pending",
				"archive_status.eq.failed",
				`first_archived_at.lt.${cutoff}`,
			].join(","),
		)
		.order("fetched_at", { ascending: false })
		.limit(opts.limit ?? 500);

	if (error) throw new Error(`collectRows: ${error.message}`);
	return (data ?? []) as QvcRow[];
}

async function archiveOne(
	row: QvcRow,
	opts: ArchiveQvcOptions,
	onProgress: (msg: string) => void,
): Promise<"complete" | "partial" | "failed"> {
	const sb = getServiceClient();
	const keyPrefix = `qvc/${row.id}`;
	let status: "complete" | "partial" | "failed" = "complete";
	const errors: string[] = [];

	const update: Record<string, unknown> = {
		archive_status: "running",
		last_seen_at: new Date().toISOString(),
	};
	const { error: lockErr } = await sb
		.from("qvc_products")
		.update({ ...update, archive_attempts: 1 })
		.eq("id", row.id);
	if (lockErr) onProgress(`  lock failed: ${lockErr.message}`);

	// 1) HTML snapshot
	try {
		const snap = await snapshotHtml(row.source_url, `${keyPrefix}/page.html.gz`);
		if (snap) {
			update.archived_html_s3 = snap.upload.url;
			update.archived_text = snap.extractedText;
		} else {
			errors.push("html snapshot failed");
			status = "partial";
		}
	} catch (e) {
		errors.push(`html: ${e instanceof Error ? e.message : String(e)}`);
		status = "partial";
	}

	// 2) Images
	const imageUrls = row.image_urls ?? [];
	if (imageUrls.length > 0) {
		try {
			const batch = await downloadAndUploadImages(imageUrls, keyPrefix, { concurrency: 4 });
			update.archived_image_s3 = batch.uploads.map((u) => u.url);
			update.archived_thumbnail_s3 = batch.uploads[0]?.url ?? null;
			if (batch.failed.length > 0) {
				errors.push(`${batch.failed.length} image(s) failed`);
				status = "partial";
			}
		} catch (e) {
			errors.push(`images: ${e instanceof Error ? e.message : String(e)}`);
			status = "partial";
		}
	}

	// 3) Reviews (cheap JSON API call — always run, regardless of skipVideo)
	try {
		const rev = await fetchAndStoreQvcReviews(row.id);
		onProgress(`  reviews: ${rev.reviewCount} (avg ${rev.averageRating}) — ${rev.upserted} upserted`);
	} catch (e) {
		errors.push(`reviews: ${e instanceof Error ? e.message : String(e)}`);
		status = "partial";
	}

	// 4) Video
	if (!opts.skipVideo && row.video_url) {
		try {
			const vid = await convertHlsToMp4AndUpload(row.video_url, {
				key: `qvc/${row.id}.mp4`,
				quality: opts.videoQuality ?? "source",
				onProgress: (line) => onProgress(`  ${line}`),
			});
			update.archived_video_s3 = vid.upload.url;
			update.video_size_bytes = vid.upload.bytes;
			update.video_duration_sec = vid.duration_sec;
			update.video_quality = vid.quality;
		} catch (e) {
			errors.push(`video: ${e instanceof Error ? e.message : String(e)}`);
			status = "partial";
		}
	}

	// 5) Persist outcome
	update.archive_status = status;
	if (errors.length > 0) update.archive_error = errors.join(" | ");
	else update.archive_error = null;
	if (!row.first_archived_at) update.first_archived_at = new Date().toISOString();

	const { error: upErr } = await sb.from("qvc_products").update(update).eq("id", row.id);
	if (upErr) {
		onProgress(`  persist failed: ${upErr.message}`);
		return "failed";
	}
	return status;
}

export async function archiveQvcProducts(
	opts: ArchiveQvcOptions = {},
): Promise<ArchiveQvcResult> {
	const onProgress = opts.onProgress ?? (() => {});
	const pause = opts.rowPauseMs ?? 1500;

	const rows = await collectRows(opts);
	let completed = 0;
	let partial = 0;
	let failed = 0;

	onProgress(`Archiving ${rows.length} QVC products...`);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		onProgress(`[${i + 1}/${rows.length}] ${row.id}`);
		try {
			const result = await archiveOne(row, opts, onProgress);
			if (result === "complete") completed++;
			else if (result === "partial") partial++;
			else failed++;
		} catch (e) {
			failed++;
			onProgress(`  error: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (i + 1 < rows.length) await sleep(pause);
	}

	return { candidates: rows.length, completed, partial, failed };
}
