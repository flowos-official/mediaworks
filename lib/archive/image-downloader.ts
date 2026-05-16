import { uploadBytes, type UploadResult } from "./upload";

const DEFAULT_TIMEOUT_MS = 15_000;

const MIME_BY_EXT: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
};

function extOf(url: string): string {
	const m = url.match(/\.(jpe?g|png|gif|webp|avif)(?:\?|$)/i);
	return m ? `.${m[1].toLowerCase()}` : ".jpg";
}

function mimeOf(url: string, headerContentType: string | null): string {
	if (headerContentType && headerContentType.startsWith("image/")) return headerContentType;
	return MIME_BY_EXT[extOf(url)] ?? "application/octet-stream";
}

async function fetchBytes(
	url: string,
	timeoutMs: number,
): Promise<{ bytes: Uint8Array; contentType: string | null } | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			redirect: "follow",
			headers: { "User-Agent": "MediaWorks-Archiver/1.0" },
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		const ab = await res.arrayBuffer();
		return { bytes: new Uint8Array(ab), contentType: res.headers.get("content-type") };
	} catch {
		clearTimeout(timer);
		return null;
	}
}

/**
 * Download one image and upload it to the archives bucket.
 *
 * Key convention: `{channel}/{productId}/img-{index}{ext}` — extension preserved
 * so the served Content-Type is right and Range requests work.
 */
export async function downloadAndUploadImage(
	url: string,
	key: string,
): Promise<UploadResult | null> {
	const fetched = await fetchBytes(url, DEFAULT_TIMEOUT_MS);
	if (!fetched) return null;
	return uploadBytes("archives", key, fetched.bytes, {
		contentType: mimeOf(url, fetched.contentType),
	});
}

export interface ImageBatchResult {
	uploads: UploadResult[];
	failed: string[];
}

/**
 * Download a batch of image URLs in parallel (concurrency-limited) and upload
 * each to the archives bucket. Returns the successful uploads and the URLs
 * that failed.
 */
export async function downloadAndUploadImages(
	urls: string[],
	keyPrefix: string,
	opts: { concurrency?: number } = {},
): Promise<ImageBatchResult> {
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));
	const uploads: UploadResult[] = [];
	const failed: string[] = [];

	for (let i = 0; i < urls.length; i += concurrency) {
		const chunk = urls.slice(i, i + concurrency);
		const results = await Promise.all(
			chunk.map(async (url, idxInChunk) => {
				const idx = i + idxInChunk;
				const key = `${keyPrefix}/img-${String(idx).padStart(2, "0")}${extOf(url)}`;
				const r = await downloadAndUploadImage(url, key);
				return { url, result: r };
			}),
		);
		for (const { url, result } of results) {
			if (result) uploads.push(result);
			else failed.push(url);
		}
	}

	return { uploads, failed };
}
