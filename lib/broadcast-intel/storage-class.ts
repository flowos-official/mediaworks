/**
 * Is the archived object actually retrievable right now?
 *
 * A lifecycle rule on the archive bucket transitions objects to
 * DEEP_ARCHIVE after one day — measured 2026-08-27: 5,051 of 5,089 objects
 * (3.24 of 3.27 TB) are already cold, and only that day's 38 are STANDARD.
 * A cold object still answers HEAD with full metadata, so nothing upstream
 * looks wrong; it is the GET that returns AccessDenied. Without this check a
 * drain spends a 1.2 GB request per slot to discover that, and the failure
 * reads like a permissions problem rather than what it is.
 *
 * This is a HeadObject — metadata only, no transfer.
 *
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { getVideoStorageClient } from "@/lib/broadcasts/video-storage";

/** Classes that cannot serve a GET without an explicit restore first. */
const COLD = new Set(["GLACIER", "DEEP_ARCHIVE"]);

export interface StorageState {
	/** Retrievable right now. */
	retrievable: boolean;
	/** S3 storage class; STANDARD when the header is absent. */
	storageClass: string;
	/** True while a restore is in progress or has completed but not expired. */
	restored: boolean;
}

export async function checkStorageClass(key: string): Promise<StorageState> {
	const Bucket = process.env.VIDEO_ARCHIVE_AWS_BUCKET;
	if (!Bucket) throw new Error("Missing required env var: VIDEO_ARCHIVE_AWS_BUCKET");

	const head = await getVideoStorageClient().send(
		new HeadObjectCommand({ Bucket, Key: key }),
	);
	const storageClass = head.StorageClass ?? "STANDARD";
	// Restore header looks like: ongoing-request="false", expiry-date="..."
	const restored = typeof head.Restore === "string" && head.Restore.includes('ongoing-request="false"');
	return {
		storageClass,
		restored,
		retrievable: !COLD.has(storageClass) || restored,
	};
}
