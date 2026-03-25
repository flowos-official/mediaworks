/**
 * One-time S3 bucket setup script
 *
 * Usage: npx tsx scripts/setup-s3.ts
 */

import "dotenv/config";
import {
	S3Client,
	CreateBucketCommand,
	PutBucketPolicyCommand,
	PutBucketCorsCommand,
	PutPublicAccessBlockCommand,
	HeadBucketCommand,
} from "@aws-sdk/client-s3";

const BUCKET = process.env.AWS_S3_BUCKET ?? "mediaworks-product-images";
const REGION = process.env.AWS_S3_REGION ?? "ap-northeast-1";

const s3 = new S3Client({
	region: REGION,
	credentials: {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
	},
});

async function main() {
	// Check if bucket already exists
	try {
		await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
		console.log(`Bucket "${BUCKET}" already exists.`);
	} catch {
		console.log(`Creating bucket "${BUCKET}" in ${REGION}...`);
		await s3.send(
			new CreateBucketCommand({
				Bucket: BUCKET,
				CreateBucketConfiguration: { LocationConstraint: REGION as "ap-northeast-1" },
			}),
		);
		console.log("Bucket created.");
	}

	// Disable Block Public Access
	await s3.send(
		new PutPublicAccessBlockCommand({
			Bucket: BUCKET,
			PublicAccessBlockConfiguration: {
				BlockPublicAcls: false,
				IgnorePublicAcls: false,
				BlockPublicPolicy: false,
				RestrictPublicBuckets: false,
			},
		}),
	);
	console.log("Block Public Access disabled.");

	// Public read policy
	const policy = {
		Version: "2012-10-17",
		Statement: [
			{
				Sid: "PublicReadGetObject",
				Effect: "Allow",
				Principal: "*",
				Action: "s3:GetObject",
				Resource: `arn:aws:s3:::${BUCKET}/*`,
			},
		],
	};
	await s3.send(
		new PutBucketPolicyCommand({
			Bucket: BUCKET,
			Policy: JSON.stringify(policy),
		}),
	);
	console.log("Public read policy set.");

	// CORS
	await s3.send(
		new PutBucketCorsCommand({
			Bucket: BUCKET,
			CORSConfiguration: {
				CORSRules: [
					{
						AllowedHeaders: ["*"],
						AllowedMethods: ["GET"],
						AllowedOrigins: [
							"http://localhost:3000",
							"https://mediaworks-six.vercel.app",
							"https://*.vercel.app",
						],
						MaxAgeSeconds: 86400,
					},
				],
			},
		}),
	);
	console.log("CORS configured.");
	console.log(`\nDone! Public URL pattern: https://${BUCKET}.s3.${REGION}.amazonaws.com/{key}`);
}

main().catch(console.error);
