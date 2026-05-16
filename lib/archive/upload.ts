import { PutObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";
import { getS3Client, getBucket, publicUrl, type BucketKind } from "./s3-client";

export interface UploadResult {
	bucket: string;
	key: string;
	url: string;
	bytes: number;
}

export interface UploadOptions {
	contentType: string;
	cacheControl?: string;
	contentEncoding?: "gzip";
}

export async function uploadBytes(
	kind: BucketKind,
	key: string,
	body: Uint8Array | Buffer,
	opts: UploadOptions,
): Promise<UploadResult> {
	const bucket = getBucket(kind);
	const input: PutObjectCommandInput = {
		Bucket: bucket,
		Key: key,
		Body: body,
		ContentType: opts.contentType,
		CacheControl: opts.cacheControl ?? "public, max-age=31536000, immutable",
	};
	if (opts.contentEncoding) input.ContentEncoding = opts.contentEncoding;
	await getS3Client().send(new PutObjectCommand(input));
	return {
		bucket,
		key,
		url: publicUrl(kind, key),
		bytes: body.byteLength,
	};
}

/**
 * gzip-compress a string and upload it as text. Standard pattern for raw HTML
 * snapshots — saves ~70% on storage with no client-side change required (S3
 * serves `Content-Encoding: gzip`, browsers decompress).
 */
export async function uploadTextGzipped(
	kind: BucketKind,
	key: string,
	text: string,
	contentType: string,
): Promise<UploadResult> {
	const buf = gzipSync(Buffer.from(text, "utf-8"));
	return uploadBytes(kind, key, buf, {
		contentType,
		contentEncoding: "gzip",
	});
}
