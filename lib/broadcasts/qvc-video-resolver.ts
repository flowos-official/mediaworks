/**
 * Shared QVC archivable-video resolver.
 *
 * QVC has no per-program broadcast m3u8 (unlike ShopCh, which derives one from
 * programId). Its only archivable video is a per-PRODUCT digest clip stored on
 * qvc_products.video_url (e.g. .../digest_product/{id}/ec.m3u8). A broadcast
 * slot lists several products; the LEAD product frequently has no digest while
 * a later one does — so we must scan all product ids in slot order, not just
 * product_ids[0]. The download path and the reconciliation probe share this
 * resolver so the "is there a video?" answer and the "what do we download?"
 * answer can never diverge (the bug that left 28 whitelist slots deferred).
 *
 * NOTE: intentionally NO `import "server-only"` — imported by archive-
 * reconciliation.ts, which is in turn imported by tsx smoke scripts.
 */
import { getServiceClient } from "@/lib/supabase";

/** Absolute https URL for a qvc_products.video_url, or null. */
export function normalizeVideoUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	return url.startsWith("http") ? url : `https:${url}`;
}

/** Pure: first product (in slot order) that has a video_url, normalized. */
export function pickFirstVideoUrl(
	productIds: readonly string[] | null | undefined,
	videoUrlById: ReadonlyMap<string, string | null | undefined>,
): string | null {
	if (!productIds) return null;
	for (const pid of productIds) {
		const u = normalizeVideoUrl(videoUrlById.get(pid));
		if (u) return u;
	}
	return null;
}

/** Resolve a QVC slot's archivable video by scanning ALL its products'
 * cached digest clips. Returns the first available (slot order), or null. */
export async function resolveQvcVideoUrl(
	productIds: readonly string[] | null | undefined,
): Promise<string | null> {
	if (!productIds || productIds.length === 0) return null;
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("qvc_products")
		.select("id, video_url")
		.in("id", productIds as string[]);
	// A transient query failure must NOT be silently read as "no video" — that
	// would defer a slot (download) or mark it no_source (reconcile) when a video
	// may well exist. Throw so the caller's retry/attempt logic handles it.
	if (error) throw new Error(`resolveQvcVideoUrl: qvc_products query failed: ${error.message}`);
	const byId = new Map<string, string | null>();
	for (const p of (data ?? []) as { id: string; video_url: string | null }[]) {
		byId.set(p.id, p.video_url);
	}
	return pickFirstVideoUrl(productIds, byId);
}
