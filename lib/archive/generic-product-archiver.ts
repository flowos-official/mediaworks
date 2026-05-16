import * as cheerio from "cheerio";
import { politeFetch } from "@/lib/broadcasts/fetch";
import { downloadAndUploadImages } from "./image-downloader";
import { uploadTextGzipped } from "./upload";
import { convertHlsToMp4AndUpload, checkFfmpegAvailable } from "./video-pipeline";
import { extractJsonLd, type JsonLdOffer } from "./jsonld";

export interface GenericArchiveOptions {
	productUrl: string;
	/** Key prefix in the archives bucket, e.g. `ntv/abc123`. */
	keyPrefix: string;
	/** Whether to download & re-encode the video too. Default false (videos are heavy). */
	includeVideo?: boolean;
	/** "720p" (default) or "source". */
	videoQuality?: "720p" | "source";
	/** Video object key relative to the videos bucket, e.g. `ntv/abc123.mp4`. */
	videoKey?: string;
	onProgress?: (msg: string) => void;
}

export interface GenericArchiveResult {
	ok: boolean;
	// Extracted product meta
	title: string | null;
	description: string | null;
	price_text: string | null;
	price_jpy: number | null;
	currency: string | null;
	brand: string | null;
	image_urls: string[];
	video_url: string | null;
	extracted_text: string;
	// JSON-LD enrichment
	description_long: string | null;
	sku_variants: JsonLdOffer[] | null;
	video_upload_date: string | null;
	jsonld_raw: unknown[] | null;
	// S3 uploads
	archived_html_s3: string | null;
	archived_thumbnail_s3: string | null;
	archived_image_s3: string[];
	archived_video_s3: string | null;
	video_size_bytes: number | null;
	video_duration_sec: number | null;
	video_quality: string | null;
	errors: string[];
}

const PRICE_RE = /(¥|￥|JPY)\s*([0-9,]+)|([0-9,]+)\s*円/;

function parseJpyPrice(text: string | null | undefined): number | null {
	if (!text) return null;
	const m = text.match(PRICE_RE);
	if (!m) return null;
	const digits = (m[2] ?? m[3] ?? "").replace(/,/g, "");
	if (!digits) return null;
	const n = Number(digits);
	return Number.isFinite(n) ? n : null;
}

function extractMeta(html: string): Omit<
	GenericArchiveResult,
	| "ok"
	| "archived_html_s3"
	| "archived_thumbnail_s3"
	| "archived_image_s3"
	| "archived_video_s3"
	| "video_size_bytes"
	| "video_duration_sec"
	| "video_quality"
	| "errors"
> {
	const $ = cheerio.load(html);
	const ld = extractJsonLd(html);

	const title =
		$('meta[property="og:title"]').attr("content")?.trim() ||
		$("title").first().text().trim() ||
		null;
	const description =
		$('meta[property="og:description"]').attr("content")?.trim() ||
		$('meta[name="description"]').attr("content")?.trim() ||
		null;
	const brand =
		$('meta[property="product:brand"]').attr("content")?.trim() ||
		$('meta[property="og:brand"]').attr("content")?.trim() ||
		null;
	const video_url =
		$('meta[property="og:video"]').attr("content")?.trim() ||
		$('meta[property="og:video:url"]').attr("content")?.trim() ||
		$('meta[property="og:video:secure_url"]').attr("content")?.trim() ||
		null;

	// Multiple og:image entries (the spec allows this).
	const image_urls: string[] = [];
	$('meta[property="og:image"], meta[property="og:image:url"], meta[property="og:image:secure_url"]').each(
		(_, el) => {
			const v = $(el).attr("content")?.trim();
			if (v && !image_urls.includes(v)) image_urls.push(v);
		},
	);

	const priceAmount =
		$('meta[property="og:price:amount"]').attr("content")?.trim() ||
		$('meta[property="product:price:amount"]').attr("content")?.trim() ||
		null;
	const currency =
		$('meta[property="og:price:currency"]').attr("content")?.trim() ||
		$('meta[property="product:price:currency"]').attr("content")?.trim() ||
		null;

	// Fallback: scan visible text for a yen-pattern price
	let price_text: string | null = null;
	let price_jpy: number | null = priceAmount ? Number(priceAmount.replace(/,/g, "")) : null;
	if (!price_jpy) {
		const bodyText = $("body").text();
		const m = bodyText.match(PRICE_RE);
		if (m) {
			price_text = m[0];
			price_jpy = parseJpyPrice(m[0]);
		}
	} else {
		price_text = priceAmount;
	}

	$("script, style, noscript, nav, header, footer, iframe").remove();
	const extracted_text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 100_000);

	// JSON-LD enrichment (Schema.org Product + VideoObject)
	const description_long = ld.video?.description ?? ld.product?.description ?? null;
	const sku_variants = ld.product?.offers ?? null;
	const video_upload_date = ld.video?.uploadDate ?? null;
	const jsonld_raw = ld.blocks.length > 0 ? ld.blocks : null;
	const finalBrand = brand ?? ld.product?.brand ?? null;
	const finalImageUrls = image_urls.length > 0 ? image_urls : (ld.product?.image ?? []);
	const finalVideoUrl = video_url ?? ld.video?.contentUrl ?? null;

	return {
		title,
		description,
		price_text,
		price_jpy,
		currency,
		brand: finalBrand,
		image_urls: finalImageUrls,
		video_url: finalVideoUrl,
		extracted_text,
		description_long,
		sku_variants,
		video_upload_date,
		jsonld_raw,
	};
}

/**
 * Generic product archiver — works on any channel that exposes OG meta tags.
 * Failures in any single sub-step are recorded in `errors[]` and partial
 * progress is still returned (no hard throw unless the page itself is unreachable).
 */
export async function archiveGenericProduct(
	opts: GenericArchiveOptions,
): Promise<GenericArchiveResult> {
	const onProgress = opts.onProgress ?? (() => {});
	const errors: string[] = [];

	const fetched = await politeFetch(opts.productUrl, { timeoutMs: 20_000 });
	if (!fetched.ok || !fetched.body) {
		return {
			ok: false,
			title: null,
			description: null,
			price_text: null,
			price_jpy: null,
			currency: null,
			brand: null,
			image_urls: [],
			video_url: null,
			extracted_text: "",
			description_long: null,
			sku_variants: null,
			video_upload_date: null,
			jsonld_raw: null,
			archived_html_s3: null,
			archived_thumbnail_s3: null,
			archived_image_s3: [],
			archived_video_s3: null,
			video_size_bytes: null,
			video_duration_sec: null,
			video_quality: null,
			errors: [`fetch: ${fetched.error ?? `HTTP ${fetched.status}`}`],
		};
	}

	const meta = extractMeta(fetched.body);

	// 1) Raw HTML.gz
	let archived_html_s3: string | null = null;
	try {
		const up = await uploadTextGzipped(
			"archives",
			`${opts.keyPrefix}/page.html.gz`,
			fetched.body,
			"text/html; charset=utf-8",
		);
		archived_html_s3 = up.url;
	} catch (e) {
		errors.push(`html: ${e instanceof Error ? e.message : String(e)}`);
	}

	// 2) Images
	let archived_thumbnail_s3: string | null = null;
	let archived_image_s3: string[] = [];
	if (meta.image_urls.length > 0) {
		try {
			const batch = await downloadAndUploadImages(meta.image_urls, opts.keyPrefix, {
				concurrency: 4,
			});
			archived_image_s3 = batch.uploads.map((u) => u.url);
			archived_thumbnail_s3 = batch.uploads[0]?.url ?? null;
			if (batch.failed.length > 0) errors.push(`${batch.failed.length} image(s) failed`);
		} catch (e) {
			errors.push(`images: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 3) Video (optional)
	let archived_video_s3: string | null = null;
	let video_size_bytes: number | null = null;
	let video_duration_sec: number | null = null;
	let video_quality: string | null = null;
	if (opts.includeVideo && meta.video_url && opts.videoKey) {
		const ffmpegOk = await checkFfmpegAvailable();
		if (!ffmpegOk) {
			errors.push("video: ffmpeg not available on PATH");
		} else {
			try {
				const r = await convertHlsToMp4AndUpload(meta.video_url, {
					key: opts.videoKey,
					quality: opts.videoQuality ?? "source",
					onProgress,
				});
				archived_video_s3 = r.upload.url;
				video_size_bytes = r.upload.bytes;
				video_duration_sec = r.duration_sec;
				video_quality = r.quality;
			} catch (e) {
				errors.push(`video: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	return {
		ok: true,
		...meta,
		archived_html_s3,
		archived_thumbnail_s3,
		archived_image_s3,
		archived_video_s3,
		video_size_bytes,
		video_duration_sec,
		video_quality,
		errors,
	};
}
