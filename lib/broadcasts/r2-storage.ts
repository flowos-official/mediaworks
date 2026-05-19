/**
 * Cloudflare R2 client wrapper. R2 implements the S3 API; the AWS SDK v3
 * works against it when we override `endpoint` and use `region: "auto"`.
 *
 * Public reads go through the bucket's R2.dev URL or a custom domain,
 * configured by R2_PUBLIC_BASE_URL. We store only the object key in
 * broadcasts.archived_video_s3 — never the full URL — so the public base
 * can change without rewriting historical rows.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

let client: S3Client | null = null;
export function getR2Client(): S3Client {
	if (client) return client;
	const accountId = requireEnv("R2_ACCOUNT_ID");
	client = new S3Client({
		region: "auto",
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
			secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
		},
		forcePathStyle: true,
	});
	return client;
}

export interface R2UploadResult {
	key: string;
	bytes: number;
}

/**
 * Stream an MP4 (or any binary) into R2 with multipart upload. Returns the
 * stored key and total bytes uploaded. Throws on hard upload failure (after
 * the SDK's internal 3× retry budget).
 */
export async function uploadStreamToR2(
	body: Readable,
	key: string,
	contentType = "video/mp4",
): Promise<R2UploadResult> {
	const bucket = requireEnv("R2_BUCKET");
	let bytes = 0;
	body.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
	});
	const upload = new Upload({
		client: getR2Client(),
		params: {
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
		},
		// 16 MB parts — R2 minimum is 5 MB, larger parts reduce round-trips.
		partSize: 16 * 1024 * 1024,
		queueSize: 4,
	});
	await upload.done();
	return { key, bytes };
}

/**
 * Build the deterministic R2 object key for a broadcast slot's archived
 * video. Same slot re-archived → overwrite (idempotent).
 */
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
