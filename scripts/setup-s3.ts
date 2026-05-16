/**
 * S3 bucket setup — idempotent. Creates the three buckets the project uses:
 *
 *   product-images  (existing)  — uploaded product file thumbnails
 *   broadcast-videos (new)      — TV-shopping video MP4s
 *   product-archives (new)      — HTML snapshots, full image sets per product
 *
 * Each bucket gets public-read policy + CORS allowing GET from the app origins.
 *
 * Usage: npx tsx scripts/setup-s3.ts
 *
 * Env vars (with defaults):
 *   AWS_S3_BUCKET             default: mediaworks-product-images
 *   AWS_S3_VIDEO_BUCKET       default: mediaworks-broadcast-videos
 *   AWS_S3_ARCHIVE_BUCKET     default: mediaworks-product-archives
 *   AWS_S3_REGION             default: ap-northeast-1
 */

import "dotenv/config";
import {
	S3Client,
	CreateBucketCommand,
	PutBucketPolicyCommand,
	PutBucketCorsCommand,
	PutPublicAccessBlockCommand,
	HeadBucketCommand,
	PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";

const REGION = process.env.AWS_S3_REGION ?? "ap-northeast-1";

const BUCKETS = [
	{
		envVar: "AWS_S3_BUCKET",
		name: process.env.AWS_S3_BUCKET ?? "mediaworks-product-images",
		purpose: "product images (existing)",
		lifecycle: false,
	},
	{
		envVar: "AWS_S3_VIDEO_BUCKET",
		name: process.env.AWS_S3_VIDEO_BUCKET ?? "mediaworks-broadcast-videos",
		purpose: "TV-shopping broadcast videos",
		lifecycle: true,
	},
	{
		envVar: "AWS_S3_ARCHIVE_BUCKET",
		name: process.env.AWS_S3_ARCHIVE_BUCKET ?? "mediaworks-product-archives",
		purpose: "product HTML snapshots + full image sets",
		lifecycle: true,
	},
];

const LIFECYCLE_TRANSITION_DAYS = Number(process.env.AWS_S3_GLACIER_IR_DAYS ?? "90");

const ALLOWED_ORIGINS = [
	"http://localhost:3000",
	"https://mediaworks-six.vercel.app",
	"https://*.vercel.app",
];

const s3 = new S3Client({
	region: REGION,
	credentials: {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
	},
});

function publicReadPolicy(bucket: string): string {
	return JSON.stringify({
		Version: "2012-10-17",
		Statement: [
			{
				Sid: "PublicReadGetObject",
				Effect: "Allow",
				Principal: "*",
				Action: "s3:GetObject",
				Resource: `arn:aws:s3:::${bucket}/*`,
			},
		],
	});
}

async function ensureLifecycle(bucket: string): Promise<void> {
	await s3.send(
		new PutBucketLifecycleConfigurationCommand({
			Bucket: bucket,
			LifecycleConfiguration: {
				Rules: [
					{
						ID: "transition-to-glacier-ir",
						Status: "Enabled",
						Filter: { Prefix: "" },
						Transitions: [
							{
								Days: LIFECYCLE_TRANSITION_DAYS,
								StorageClass: "GLACIER_IR",
							},
						],
					},
				],
			},
		}),
	);
	console.log(`  lifecycle → GLACIER_IR after ${LIFECYCLE_TRANSITION_DAYS}d`);
}

async function ensureBucket(
	bucket: string,
	purpose: string,
	withLifecycle: boolean,
): Promise<void> {
	console.log(`\n[${bucket}] (${purpose})`);

	try {
		await s3.send(new HeadBucketCommand({ Bucket: bucket }));
		console.log("  exists");
	} catch {
		console.log(`  creating in ${REGION}...`);
		await s3.send(
			new CreateBucketCommand({
				Bucket: bucket,
				CreateBucketConfiguration: { LocationConstraint: REGION as "ap-northeast-1" },
			}),
		);
		console.log("  created");
	}

	await s3.send(
		new PutPublicAccessBlockCommand({
			Bucket: bucket,
			PublicAccessBlockConfiguration: {
				BlockPublicAcls: false,
				IgnorePublicAcls: false,
				BlockPublicPolicy: false,
				RestrictPublicBuckets: false,
			},
		}),
	);
	console.log("  public-access-block disabled");

	await s3.send(
		new PutBucketPolicyCommand({
			Bucket: bucket,
			Policy: publicReadPolicy(bucket),
		}),
	);
	console.log("  public-read policy applied");

	await s3.send(
		new PutBucketCorsCommand({
			Bucket: bucket,
			CORSConfiguration: {
				CORSRules: [
					{
						AllowedHeaders: ["*"],
						AllowedMethods: ["GET", "HEAD"],
						AllowedOrigins: ALLOWED_ORIGINS,
						ExposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
						MaxAgeSeconds: 86400,
					},
				],
			},
		}),
	);
	console.log("  CORS configured");

	if (withLifecycle) await ensureLifecycle(bucket);
}

async function main() {
	if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
		console.error("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing");
		process.exit(1);
	}

	for (const b of BUCKETS) {
		await ensureBucket(b.name, b.purpose, b.lifecycle);
	}

	console.log("\nDone. Public URL pattern:");
	for (const b of BUCKETS) {
		console.log(`  ${b.envVar.padEnd(24)} → https://${b.name}.s3.${REGION}.amazonaws.com/{key}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
