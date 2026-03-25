import {
	S3Client,
	PutObjectCommand,
	DeleteObjectCommand,
} from "@aws-sdk/client-s3";

let _s3: S3Client | null = null;

function getS3Client(): S3Client {
	if (!_s3) {
		_s3 = new S3Client({
			region: process.env.AWS_S3_REGION ?? "ap-northeast-1",
			credentials: {
				accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
				secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
			},
		});
	}
	return _s3;
}

function getBucket(): string {
	return process.env.AWS_S3_BUCKET ?? "mediaworks-product-images";
}

function getRegion(): string {
	return process.env.AWS_S3_REGION ?? "ap-northeast-1";
}

export function getS3PublicUrl(key: string): string {
	return `https://${getBucket()}.s3.${getRegion()}.amazonaws.com/${encodeURI(key)}`;
}

export async function uploadToS3(
	key: string,
	body: Buffer | Uint8Array,
	contentType: string,
): Promise<string> {
	await getS3Client().send(
		new PutObjectCommand({
			Bucket: getBucket(),
			Key: key,
			Body: body,
			ContentType: contentType,
		}),
	);
	return getS3PublicUrl(key);
}

export async function deleteFromS3(key: string): Promise<void> {
	await getS3Client().send(
		new DeleteObjectCommand({
			Bucket: getBucket(),
			Key: key,
		}),
	);
}
