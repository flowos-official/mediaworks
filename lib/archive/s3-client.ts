import { S3Client } from "@aws-sdk/client-s3";

export type BucketKind = "images" | "videos" | "archives";

const REGION = process.env.AWS_S3_REGION ?? "ap-northeast-1";

let _client: S3Client | null = null;

export function getS3Client(): S3Client {
	if (!_client) {
		_client = new S3Client({
			region: REGION,
			credentials: {
				accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
				secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
			},
		});
	}
	return _client;
}

export function getBucket(kind: BucketKind): string {
	switch (kind) {
		case "images":
			return process.env.AWS_S3_BUCKET ?? "mediaworks-product-images";
		case "videos":
			return process.env.AWS_S3_VIDEO_BUCKET ?? "mediaworks-broadcast-videos";
		case "archives":
			return process.env.AWS_S3_ARCHIVE_BUCKET ?? "mediaworks-product-archives";
	}
}

export function getRegion(): string {
	return REGION;
}

export function publicUrl(kind: BucketKind, key: string): string {
	const bucket = getBucket(kind);
	return `https://${bucket}.s3.${REGION}.amazonaws.com/${key}`;
}
