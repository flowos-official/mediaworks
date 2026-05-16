/**
 * Archive worker for the 10 non-broadcasts TV channels (and exploration tracks).
 * Walks `discovered_products` rows that are pending/failed/stale and runs the
 * generic OG-based archiver for each. Designed to be called from a script or
 * cron; safe to interrupt mid-batch (each row commits independently).
 */

import { getServiceClient } from "@/lib/supabase";
import { sleep } from "@/lib/broadcasts/fetch";
import { archiveGenericProduct } from "@/lib/archive/generic-product-archiver";
import { fetchAndStoreQvcReviews } from "@/lib/qvc-products/reviews";

export interface ArchiveDiscoveredOptions {
	limit?: number;
	/** Re-archive rows older than this many hours. Default 30 days. */
	staleHours?: number;
	/** Run ffmpeg + S3 upload for videos when found. Default false. */
	includeVideo?: boolean;
	videoQuality?: "720p" | "source";
	rowPauseMs?: number;
	onProgress?: (msg: string) => void;
}

export interface ArchiveDiscoveredResult {
	candidates: number;
	completed: number;
	partial: number;
	failed: number;
}

interface DiscoveredRow {
	id: string;
	product_url: string;
	source: string;
	first_archived_at: string | null;
}

function slugForKey(url: string): string {
	// Stable, file-safe slug from URL. e.g. ntv | shopch | rakuten
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "_");
	} catch {
		return "unknown";
	}
}

async function collectRows(
	opts: ArchiveDiscoveredOptions,
): Promise<DiscoveredRow[]> {
	const sb = getServiceClient();
	const staleHours = opts.staleHours ?? 24 * 30;
	const cutoff = new Date(Date.now() - staleHours * 3600_000).toISOString();

	const { data, error } = await sb
		.from("discovered_products")
		.select("id, product_url, source, first_archived_at")
		.or(
			[
				"archive_status.is.null",
				"archive_status.eq.pending",
				"archive_status.eq.failed",
				`first_archived_at.lt.${cutoff}`,
			].join(","),
		)
		.order("created_at", { ascending: false })
		.limit(opts.limit ?? 100);

	if (error) throw new Error(`collectRows: ${error.message}`);
	return (data ?? []) as DiscoveredRow[];
}

export async function archiveDiscoveredProducts(
	opts: ArchiveDiscoveredOptions = {},
): Promise<ArchiveDiscoveredResult> {
	const sb = getServiceClient();
	const onProgress = opts.onProgress ?? (() => {});
	const pause = opts.rowPauseMs ?? 1500;

	const rows = await collectRows(opts);
	let completed = 0;
	let partial = 0;
	let failed = 0;

	onProgress(`Archiving ${rows.length} discovered_products row(s)...`);

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const slug = slugForKey(row.product_url);
		const keyPrefix = `${slug}/${row.id}`;
		onProgress(`[${i + 1}/${rows.length}] ${slug} ${row.id}`);

		await sb
			.from("discovered_products")
			.update({
				archive_status: "running",
				last_seen_at: new Date().toISOString(),
			})
			.eq("id", row.id);

		try {
			const r = await archiveGenericProduct({
				productUrl: row.product_url,
				keyPrefix,
				includeVideo: opts.includeVideo,
				videoQuality: opts.videoQuality,
				videoKey: opts.includeVideo ? `discovery/${row.id}.mp4` : undefined,
				onProgress: (msg) => onProgress(`  ${msg}`),
			});

			if (!r.ok) {
				failed++;
				await sb
					.from("discovered_products")
					.update({
						archive_status: "failed",
						archive_error: r.errors.join(" | ").slice(0, 500),
					})
					.eq("id", row.id);
				continue;
			}

			// Reviews — if this is a QVC URL, call the QVC reviews API.
			// reqprno is the last digit-only segment of /product.NNN.html.
			let reviewSummary: { count: number; avg: number } | null = null;
			const qvcIdMatch = row.product_url.match(/qvc\.jp\/product\.(\d+)\.html/);
			if (qvcIdMatch) {
				try {
					const rv = await fetchAndStoreQvcReviews(qvcIdMatch[1]);
					reviewSummary = { count: rv.reviewCount, avg: rv.averageRating };
					onProgress(`  reviews: ${rv.reviewCount} (avg ${rv.averageRating})`);
				} catch (e) {
					r.errors.push(`reviews: ${e instanceof Error ? e.message : String(e)}`);
				}
			}

			const status = r.errors.length > 0 ? "partial" : "complete";
			if (status === "complete") completed++;
			else partial++;

			await sb
				.from("discovered_products")
				.update({
					archive_status: status,
					archive_error: r.errors.length > 0 ? r.errors.join(" | ").slice(0, 500) : null,
					archived_html_s3: r.archived_html_s3,
					archived_text: r.extracted_text,
					archived_thumbnail_s3: r.archived_thumbnail_s3,
					archived_image_s3: r.archived_image_s3.length > 0 ? r.archived_image_s3 : null,
					video_source_url: r.video_url,
					archived_video_s3: r.archived_video_s3,
					video_size_bytes: r.video_size_bytes,
					video_duration_sec: r.video_duration_sec,
					video_quality: r.video_quality,
					description_long: r.description_long,
					sku_variants: r.sku_variants,
					jsonld_raw: r.jsonld_raw,
					review_count: reviewSummary?.count ?? null,
					review_avg: reviewSummary && reviewSummary.count > 0 ? reviewSummary.avg : null,
					reviews_fetched_at: reviewSummary ? new Date().toISOString() : null,
					first_archived_at: row.first_archived_at ?? new Date().toISOString(),
				})
				.eq("id", row.id);
		} catch (e) {
			failed++;
			const msg = e instanceof Error ? e.message : String(e);
			await sb
				.from("discovered_products")
				.update({
					archive_status: "failed",
					archive_error: msg.slice(0, 500),
				})
				.eq("id", row.id);
			onProgress(`  unexpected: ${msg}`);
		}

		if (i + 1 < rows.length) await sleep(pause);
	}

	return { candidates: rows.length, completed, partial, failed };
}
