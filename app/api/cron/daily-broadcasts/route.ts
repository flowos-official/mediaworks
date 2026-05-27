import { type NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { scrapeAllForDate } from "@/lib/broadcasts";
import { enrichQvcProducts } from "@/lib/qvc-products/enrich";
import { getServiceClient } from "@/lib/supabase";
import { loadWhitelist, isAllowed } from "@/lib/broadcasts/category-filter";
import { getYesterdayJST, getJSTYearMonth } from "@/lib/broadcasts/jst-date";
import {
	buildQvcSnapshotRows,
	buildShopChSnapshotRows,
	pickBrandFromQvcProducts,
	type QvcProductLike,
} from "@/lib/broadcasts/snapshot-enrichment";
import { buildProgramId } from "@/lib/broadcasts/shopch-json";

export const maxDuration = 120;

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

/**
 * Enrich broadcast_products and broadcasts.brand_name for QVC slots.
 * Only processes slots that (a) have product_ids and (b) pass the whitelist check.
 */
async function enrichQvcSlotSnapshots(
	qvcSlots: Array<{ channel: string; air_date: string; start_time: string; product_ids: string[] | null; category: string | null }>,
	broadcastIdMap: Map<string, string>,
	whitelist: Map<string, Set<string>>,
): Promise<{ snapshotRows: number; brandUpdates: number; videoQueued: number; videoDeferred: number }> {
	const sb = getServiceClient();
	let snapshotRows = 0;
	let brandUpdates = 0;
	let videoQueued = 0;
	let videoDeferred = 0;

	// Collect all unique product IDs from whitelist-matching slots.
	const eligibleSlots = qvcSlots.filter(
		(s) => s.product_ids && s.product_ids.length > 0 && isAllowed(whitelist, "qvc", s.category),
	);
	if (eligibleSlots.length === 0) return { snapshotRows, brandUpdates, videoQueued, videoDeferred };

	const allProductIds = [...new Set(eligibleSlots.flatMap((s) => s.product_ids ?? []))];

	// Fetch qvc_products rows for all needed IDs in one query.
	const { data: qvcProductRows, error: productError } = await sb
		.from("qvc_products")
		.select("id,name,image_url,price_text,brand,original_price_jpy,sale_label,video_url")
		.in("id", allProductIds);

	if (productError) {
		console.warn("[snapshot] qvc_products fetch failed:", productError.message);
		return { snapshotRows, brandUpdates, videoQueued, videoDeferred };
	}

	const products = (qvcProductRows ?? []) as (QvcProductLike & { video_url?: string | null })[];

	for (const slot of eligibleSlots) {
		const key = `${slot.channel}|${slot.air_date}|${slot.start_time}`;
		const broadcastId = broadcastIdMap.get(key);
		if (!broadcastId) continue;

		const productIds = slot.product_ids ?? [];
		const slotProducts = products.filter((p) => productIds.includes(p.id));

		// Build snapshot rows and upsert.
		const rows = buildQvcSnapshotRows(broadcastId, productIds, slotProducts);
		if (rows.length > 0) {
			const { error: upsertErr } = await sb
				.from("broadcast_products")
				.upsert(rows, { onConflict: "broadcast_id,product_id" });
			if (upsertErr) {
				console.warn(`[snapshot] qvc broadcast_products upsert failed for ${broadcastId}:`, upsertErr.message);
			} else {
				snapshotRows += rows.length;
			}
		}

		// Update brand_name + video_status in a single broadcasts UPDATE.
		const brand = pickBrandFromQvcProducts(productIds, slotProducts);
		const hasVideo = slotProducts.some((p) => p.video_url);
		const videoStatus = hasVideo ? "queued" : "deferred";
		const broadcastUpdate: Record<string, string | null> = { video_status: videoStatus };
		if (brand) broadcastUpdate.brand_name = brand;
		const { error: broadcastErr } = await sb
			.from("broadcasts")
			.update(broadcastUpdate)
			.eq("id", broadcastId);
		if (broadcastErr) {
			console.warn(`[snapshot] broadcasts update failed for ${broadcastId}:`, broadcastErr.message);
		} else {
			if (brand) brandUpdates++;
			if (hasVideo) videoQueued++;
			else videoDeferred++;
		}
	}

	return { snapshotRows, brandUpdates, videoQueued, videoDeferred };
}

/**
 * Enrich broadcast_products and broadcasts.brand_name/brand_code for ShopCh slots.
 * Only processes slots that pass the whitelist check and have metadata in the map.
 */
async function enrichShopChSlotSnapshots(
	shopchSlots: Array<{ channel: string; air_date: string; start_time: string; category: string | null }>,
	shopchMetadataByProgramId: Map<string, import("@/lib/broadcasts/shopch-json").ShopChSlotMetadata>,
	broadcastIdMap: Map<string, string>,
	whitelist: Map<string, Set<string>>,
): Promise<{ snapshotRows: number; brandUpdates: number; videoQueued: number; videoDeferred: number }> {
	const sb = getServiceClient();
	let snapshotRows = 0;
	let brandUpdates = 0;
	let videoQueued = 0;
	let videoDeferred = 0;

	for (const slot of shopchSlots) {
		if (!isAllowed(whitelist, "shopch", slot.category)) continue;

		const programId = buildProgramId(slot.air_date, slot.start_time);
		const meta = shopchMetadataByProgramId.get(programId);
		if (!meta || meta.products.length === 0) continue;

		const key = `${slot.channel}|${slot.air_date}|${slot.start_time}`;
		const broadcastId = broadcastIdMap.get(key);
		if (!broadcastId) continue;

		// Build snapshot rows and upsert.
		const rows = buildShopChSnapshotRows(broadcastId, meta.products);
		if (rows.length > 0) {
			const { error: upsertErr } = await sb
				.from("broadcast_products")
				.upsert(rows, { onConflict: "broadcast_id,product_id" });
			if (upsertErr) {
				console.warn(`[snapshot] shopch broadcast_products upsert failed for ${broadcastId}:`, upsertErr.message);
			} else {
				snapshotRows += rows.length;
			}
		}

		// Update brand_name + brand_code + video_status in a single broadcasts UPDATE.
		// pgmMovie (meta.videoPath) signals an aired-program video on shopch.jp;
		// the archive cron derives the m3u8 URL from programId at run time.
		const hasVideo = !!meta.videoPath;
		const videoStatus = hasVideo ? "queued" : "deferred";
		const shopchUpdate: Record<string, string | null> = { video_status: videoStatus };
		if (meta.brandName) shopchUpdate.brand_name = meta.brandName;
		if (meta.brandCode) shopchUpdate.brand_code = meta.brandCode;
		const { error: broadcastErr } = await sb
			.from("broadcasts")
			.update(shopchUpdate)
			.eq("id", broadcastId);
		if (broadcastErr) {
			console.warn(`[snapshot] shopch broadcasts update failed for ${broadcastId}:`, broadcastErr.message);
		} else {
			if (meta.brandName || meta.brandCode) brandUpdates++;
			if (hasVideo) videoQueued++;
			else videoDeferred++;
		}
	}

	return { snapshotRows, brandUpdates, videoQueued, videoDeferred };
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const start = Date.now();
	const target = getYesterdayJST(new Date());
	const targetIso = target.toISOString().slice(0, 10);

	const summary = await scrapeAllForDate(target);

	// Enrich QVC products for just the day we scraped. Typical QVC slot has 1-10
	// products → ~50-100 unique IDs per day, well under maxDuration=120s at concurrency=3.
	const enrich = await enrichQvcProducts({
		onlyDates: [targetIso],
		concurrency: 3,
		// onProgress intentionally omitted to keep cron logs short
	});

	// Snapshot enrichment: wire broadcast_products + brand attribution.
	// Load whitelist once; only enrich whitelist-matching slots.
	const whitelist = await loadWhitelist();

	const qvcResult = summary.results.find((r) => r.channel === "qvc");
	const shopchResult = summary.results.find((r) => r.channel === "shopch");

	const qvcSnapshot = qvcResult?.ok
		? await enrichQvcSlotSnapshots(
				qvcResult.slots as Array<{ channel: string; air_date: string; start_time: string; product_ids: string[] | null; category: string | null }>,
				summary.broadcastIds,
				whitelist,
			)
		: { snapshotRows: 0, brandUpdates: 0, videoQueued: 0, videoDeferred: 0 };

	const shopchSnapshot = shopchResult?.ok && shopchResult.shopchMetadataByProgramId
		? await enrichShopChSlotSnapshots(
				shopchResult.slots as Array<{ channel: string; air_date: string; start_time: string; category: string | null }>,
				shopchResult.shopchMetadataByProgramId,
				summary.broadcastIds,
				whitelist,
			)
		: { snapshotRows: 0, brandUpdates: 0, videoQueued: 0, videoDeferred: 0 };

	const log = {
		event: "broadcasts.scrape.summary",
		date: targetIso,
		channels: Object.fromEntries(
			summary.results.map((r) => [
				r.channel,
				{
					ok: r.ok,
					count: r.slots.length,
					...(r.error ? { error: r.error } : {}),
					coverage: r.health.fieldCoverage,
				},
			]),
		),
		totals: {
			inserted: summary.totalInserted,
			updated: summary.totalUpdated,
			errors: summary.totalErrors,
		},
		qvcProductEnrichment: {
			candidates: enrich.candidates,
			fetched: enrich.fetched,
			failed: enrich.failed,
		},
		snapshotEnrichment: {
			qvc: {
				snapshotRows: qvcSnapshot.snapshotRows,
				brandUpdates: qvcSnapshot.brandUpdates,
				videoQueued: qvcSnapshot.videoQueued,
				videoDeferred: qvcSnapshot.videoDeferred,
			},
			shopch: {
				snapshotRows: shopchSnapshot.snapshotRows,
				brandUpdates: shopchSnapshot.brandUpdates,
				videoQueued: shopchSnapshot.videoQueued,
				videoDeferred: shopchSnapshot.videoDeferred,
			},
		},
		durationMs: Date.now() - start,
	};

	// Invalidate page cache for the month we just wrote to. revalidateTag
	// failures are non-fatal — the cron's job is data ingest; stale cache
	// recovers via cacheLife's 6h revalidate fallback.
	try {
		const ym = getJSTYearMonth(target);
		revalidateTag(`broadcasts:calendar:${ym}`, "max");
		revalidateTag("broadcasts:totals", "max");
		revalidateTag("discovery:category-distribution", "max");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[cache] revalidateTag failed", { route: "daily-broadcasts", error: msg });
	}

	console.log(JSON.stringify(log));

	return NextResponse.json({ ok: true, ...log });
}
