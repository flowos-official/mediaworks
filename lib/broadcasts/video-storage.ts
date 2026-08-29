/**
 * S3-compatible video object storage wrapper. Currently configured for AWS S3
 * (with CloudFront in front for egress); the same code can target any
 * S3-compatible backend by changing endpoint/region in env vars.
 *
 * Public reads go through the CloudFront distribution URL configured in
 * VIDEO_ARCHIVE_BASE_URL. The `broadcasts.archived_video_s3` column stores
 * the object key only — never the full URL — so the CDN base URL can change
 * without rewriting historical rows.
 *
 * Env var names are intentionally namespaced (`VIDEO_ARCHIVE_AWS_*`) to avoid
 * collision with the older `lib/s3.ts` (product images) which uses bare
 * `AWS_S3_*` against a different bucket + IAM key.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import { completeManagedUpload } from "./archive-deadline";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

let client: S3Client | null = null;
export function getVideoStorageClient(): S3Client {
	if (client) return client;
	client = new S3Client({
		region: requireEnv("VIDEO_ARCHIVE_AWS_REGION"),
		credentials: {
			accessKeyId: requireEnv("VIDEO_ARCHIVE_AWS_ACCESS_KEY_ID"),
			secretAccessKey: requireEnv("VIDEO_ARCHIVE_AWS_SECRET_ACCESS_KEY"),
		},
	});
	return client;
}

export interface VideoUploadResult {
	key: string;
	bytes: number;
}

export async function uploadStreamToS3(
	body: Readable,
	key: string,
	contentType = "video/mp4",
	signal?: AbortSignal,
): Promise<VideoUploadResult> {
	const bucket = requireEnv("VIDEO_ARCHIVE_AWS_BUCKET");
	let bytes = 0;
	body.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
	});
	const upload = new Upload({
		client: getVideoStorageClient(),
		params: {
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
		},
		partSize: 16 * 1024 * 1024,
		queueSize: 4,
	});
	await completeManagedUpload(upload, signal);
	return { key, bytes };
}

export function broadcastVideoKey(
	channel: string,
	airDate: string,
	startTime: string,
	broadcastId: string,
): string {
	const shortId = broadcastId.slice(0, 8);
	const safeTime = startTime.replace(/:/g, "-");
	return `videos/${channel}/${airDate}/${safeTime}--${shortId}.mp4`;
}
