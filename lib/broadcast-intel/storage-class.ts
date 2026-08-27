/**
 * Is the archived object actually retrievable right now?
 *
 * A lifecycle rule on the archive bucket transitions objects to
 * DEEP_ARCHIVE after one day — measured 2026-08-27: 5,051 of 5,089 objects
 * (3.24 of 3.27 TB) are already cold, and only that day's 38 are STANDARD.
 * A cold object still answers a CloudFront HEAD with full metadata, so nothing
 * upstream looks wrong; it is the GET that returns AccessDenied. Without this
 * check a drain spends a full request per slot to discover that, and the
 * failure reads like a permissions problem rather than what it is.
 *
 * Uses ListObjectsV2 with the key as an exact prefix, NOT HeadObject: the
 * archiver IAM user has only PutObject and ListBucket. HeadObject is
 * authorised as s3:GetObject and returns 403 for this identity — so the
 * HeadObject version of this check threw on every call and fell through its
 * own advisory catch, silently doing nothing. Measured: the drain's three
 * cold slots were not skipped and each spent a full request to fail.
 *
 * Metadata only, no transfer either way.
 *
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getVideoStorageClient } from "@/lib/broadcasts/video-storage";

/** Classes that cannot serve a GET without an explicit restore first. */
const COLD = new Set(["GLACIER", "DEEP_ARCHIVE"]);

export interface StorageState {
	/** Retrievable right now. */
	retrievable: boolean;
	/** S3 storage class; STANDARD when the header is absent. */
	storageClass: string;
	/** Always false: restore state lives on object headers this identity
	 *  cannot read. Kept so the shape survives an s3:GetObject grant. */
	restored: boolean;
}

export async function checkStorageClass(key: string): Promise<StorageState> {
	const Bucket = process.env.VIDEO_ARCHIVE_AWS_BUCKET;
	if (!Bucket) throw new Error("Missing required env var: VIDEO_ARCHIVE_AWS_BUCKET");

	const listed = await getVideoStorageClient().send(
		new ListObjectsV2Command({ Bucket, Prefix: key, MaxKeys: 1 }),
	);
	const object = listed.Contents?.find((o) => o.Key === key);
	if (!object) {
		// Not in the bucket at all. Treat as retrievable so the caller's own
		// fetch produces the real, specific error rather than this diagnostic
		// guessing at one.
		return { storageClass: "MISSING", restored: false, retrievable: true };
	}
	// ListObjectsV2 omits the field for STANDARD.
	const storageClass = object.StorageClass ?? "STANDARD";
	// It also cannot report restore state — that lives only on the object
	// headers, which this identity cannot read. A restored cold object is
	// therefore reported as unretrievable; the drain skips it rather than
	// using it. Revisit if s3:GetObject is ever granted.
	return {
		storageClass,
		restored: false,
		retrievable: !COLD.has(storageClass),
	};
}
