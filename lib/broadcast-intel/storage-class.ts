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
 * Reads HeadObject, because restore state lives ONLY there. A restored object
 * keeps its cold StorageClass forever — measured 2026-08-28, a fully restored
 * object still reports DEEP_ARCHIVE and is readable:
 *
 *   StorageClass : DEEP_ARCHIVE
 *   Restore      : ongoing-request="false", expiry-date="Fri, 11 Sep 2026 …"
 *
 * so classifying on StorageClass alone skips every restored object. That is
 * exactly what happened to the first 家電 drain: 22 of 25 slots skipped as
 * cold hours after their restore had completed.
 *
 * Falls back to ListObjectsV2 when HeadObject is refused. HeadObject is
 * authorised as s3:GetObject; before that grant it returned 403 for this
 * identity on every call. The fallback cannot see restore state, so it is
 * strictly worse — but it degrades to the previous behaviour rather than
 * failing outright if the grant is ever withdrawn.
 *
 * Metadata only, no transfer either way.
 *
 * NO `import "server-only"` — imported by tsx smoke scripts.
 */
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getVideoStorageClient } from "@/lib/broadcasts/video-storage";

/** Classes that cannot serve a GET unless a restore has completed. */
const COLD = new Set(["GLACIER", "DEEP_ARCHIVE"]);

export interface StorageState {
	/** Retrievable right now. */
	retrievable: boolean;
	/** S3 storage class; STANDARD when the header is absent. */
	storageClass: string;
	/** A cold object whose restore has completed (temporary copy available). */
	restored: boolean;
	/** Object size in bytes; null when the size could not be read. */
	sizeBytes: number | null;
}

/**
 * True only for a *completed* restore. S3 spells an in-progress one
 * `ongoing-request="true"` — that object is still unreadable.
 */
export function isRestoreComplete(restoreHeader: string | undefined): boolean {
	if (!restoreHeader) return false;
	return /ongoing-request\s*=\s*"false"/i.test(restoreHeader);
}

function classify(storageClass: string, restored: boolean): boolean {
	return !COLD.has(storageClass) || restored;
}

export async function checkStorageClass(key: string): Promise<StorageState> {
	const Bucket = process.env.VIDEO_ARCHIVE_AWS_BUCKET;
	if (!Bucket) throw new Error("Missing required env var: VIDEO_ARCHIVE_AWS_BUCKET");
	const client = getVideoStorageClient();

	try {
		const head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
		const storageClass = head.StorageClass ?? "STANDARD";
		const restored = isRestoreComplete(head.Restore);
		return {
			storageClass,
			restored,
			retrievable: classify(storageClass, restored),
			sizeBytes: head.ContentLength ?? null,
		};
	} catch (e) {
		const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
		if (status === 404) {
			// Not in the bucket. Treat as retrievable so the caller's own fetch
			// produces the real, specific error rather than this diagnostic
			// guessing at one.
			return { storageClass: "MISSING", restored: false, retrievable: true, sizeBytes: null };
		}
		if (status !== 403) throw e;
		// s3:GetObject not granted — fall back to the list-based check, which
		// is blind to restore state.
		console.warn("[broadcast-intel] HeadObject denied; falling back to ListObjectsV2 (restore state unreadable)");
	}

	const listed = await client.send(new ListObjectsV2Command({ Bucket, Prefix: key, MaxKeys: 1 }));
	const object = listed.Contents?.find((o) => o.Key === key);
	if (!object) {
		return { storageClass: "MISSING", restored: false, retrievable: true, sizeBytes: null };
	}
	// ListObjectsV2 omits the field for STANDARD.
	const storageClass = object.StorageClass ?? "STANDARD";
	return {
		storageClass,
		restored: false,
		retrievable: !COLD.has(storageClass),
		sizeBytes: object.Size ?? null,
	};
}
