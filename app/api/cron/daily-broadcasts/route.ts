import { type NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { scrapeAllForDate } from "@/lib/broadcasts";
import { enrichQvcProducts } from "@/lib/qvc-products/enrich";
import { getServiceClient } from "@/lib/supabase";
import { loadWhitelist, isAllowed, normalizeCategory } from "@/lib/broadcasts/category-filter";
import { getYesterdayJST, getJSTYearMonth } from "@/lib/broadcasts/jst-date";
import {
	buildQvcSnapshotRows,
	buildShopChSnapshotRows,
	pickBrandFromQvcProducts,
	type QvcProductLike,
} from "@/lib/broadcasts/snapshot-enrichment";
import { buildProgramId } from "@/lib/broadcasts/shopch-json";
import { createPipelineRunRepository } from "@/lib/intelligence/pipeline-run";
import { failPipelineRunWithKnownCounts, settlePipelineRunBestEffort, startPipelineRunBestEffort } from "@/lib/intelligence/pipeline-run-route";
export const maxDuration = 180;

export function dailyBroadcastPipelineCounts(input: {
	inserted: number;
	updated: number;
	sourceErrors: number;
	enrichmentErrors: number;
	processed: number;
}) {
	return {
		new: input.inserted,
		updated: input.updated,
		duplicate: 0,
		failed: input.sourceErrors + input.enrichmentErrors,
		processed: input.processed,
	};
}

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
): Promise<{ snapshotRows: number; brandUpdates: number; videoQueued: number; videoDeferred: number; categoryBackfilled: number }> {
	const sb = getServiceClient();
	let snapshotRows = 0;
	let brandUpdates = 0;
	let videoQueued = 0;
	let videoDeferred = 0;
	let categoryBackfilled = 0;

	// Consider ALL slots with products first. A brand-new product is unenriched
	// at scrape time, so the slot's own category is NULL — but enrichQvcProducts
	// (which ran just before this) has now populated qvc_products.category, so we
	// resolve an effective category from the products and backfill the NULL
	// broadcasts.category. Without this, new whitelist slots stay category-null
	// and never enter the archive queue (fail-closed whitelist).
	const slotsWithProducts = qvcSlots.filter((s) => s.product_ids && s.product_ids.length > 0);
	if (slotsWithProducts.length === 0) return { snapshotRows, brandUpdates, videoQueued, videoDeferred, categoryBackfilled };

	const allProductIds = [...new Set(slotsWithProducts.flatMap((s) => s.product_ids ?? []))];

	// Fetch qvc_products rows for all needed IDs in one query (incl. category).
	const { data: qvcProductRows, error: productError } = await sb
		.from("qvc_products")
		.select("id,name,image_url,price_text,brand,original_price_jpy,sale_label,video_url,category")
		.in("id", allProductIds);

	if (productError) {
		console.warn("[snapshot] qvc_products fetch failed:", productError.message);
		return { snapshotRows, brandUpdates, videoQueued, videoDeferred, categoryBackfilled };
	}

	const products = (qvcProductRows ?? []) as (QvcProductLike & { video_url?: string | null; category?: string | null })[];
	const categoryById = new Map<string, string | null>();
	for (const p of products) categoryById.set(p.id, p.category ?? null);

	// Effective category: the slot's own when present, else the first product (in
	// slot order) that carries a category. Mirrors the whitelist gate's intent.
	const effectiveCategory = (s: { category: string | null; product_ids: string[] | null }): string | null => {
		if (normalizeCategory(s.category)) return s.category;
		for (const pid of s.product_ids ?? []) {
			const c = categoryById.get(pid);
			if (c) return c;
		}
		return null;
	};

	const eligibleSlots = slotsWithProducts.filter((s) => isAllowed(whitelist, "qvc", effectiveCategory(s)));
	if (eligibleSlots.length === 0) return { snapshotRows, brandUpdates, videoQueued, videoDeferred, categoryBackfilled };

	for (const slot of eligibleSlots) {
		const key = `${slot.channel}|${slot.air_date}|${slot.start_time}`;
		const broadcastId = broadcastIdMap.get(key);
		if (!broadcastId) continue;

		// Backfill a NULL broadcasts.category from the resolved product category so
		// reconciliation (which reads DB category) and the UI gate see it. CAS on
		// `category IS NULL` so we never overwrite a real value.
		if (!normalizeCategory(slot.category)) {
			const effCat = effectiveCategory(slot);
			if (effCat) {
				const { data: catUpd } = await sb
					.from("broadcasts")
					.update({ category: effCat })
					.eq("id", broadcastId)
					.is("category", null)
					.select("id");
				if (catUpd && catUpd.length > 0) categoryBackfilled++;
			}
		}

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

		// Update brand_name unconditionally, but only set video_status for slots
		// still in the initial 'pending' state. A re-run (manual backfill or
		// re-scrape) must NOT reset an already-queued/downloading/archived slot
		// back to 'queued' — that forces needless re-downloads and, since the
		// archive cron processes newest-first, starves older days. CAS guard
		// mirrors recoverQvcPending.
		const brand = pickBrandFromQvcProducts(productIds, slotProducts);
		const hasVideo = slotProducts.some((p) => p.video_url);
		const videoStatus = hasVideo ? "queued" : "deferred";

		if (brand) {
			const { error: brandErr } = await sb
				.from("broadcasts")
				.update({ brand_name: brand })
				.eq("id", broadcastId);
			if (brandErr) {
				console.warn(`[snapshot] qvc brand update failed for ${broadcastId}:`, brandErr.message);
			} else {
				brandUpdates++;
			}
		}

		const { error: broadcastErr } = await sb
			.from("broadcasts")
			.update({ video_status: videoStatus })
			.eq("id", broadcastId)
			.eq("video_status", "pending");
		if (broadcastErr) {
			console.warn(`[snapshot] qvc video_status update failed for ${broadcastId}:`, broadcastErr.message);
		} else {
			if (hasVideo) videoQueued++;
			else videoDeferred++;
		}
	}

	return { snapshotRows, brandUpdates, videoQueued, videoDeferred, categoryBackfilled };
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

		// Update brand unconditionally; guard video_status to 'pending'-only so a
		// re-run never resets an in-progress/archived slot (see QVC note above).
		// pgmMovie (meta.videoPath) signals an aired-program video on shopch.jp;
		// the archive cron derives the m3u8 URL from programId at run time.
		const hasVideo = !!meta.videoPath;
		const videoStatus = hasVideo ? "queued" : "deferred";

		const brandUpdate: Record<string, string | null> = {};
		if (meta.brandName) brandUpdate.brand_name = meta.brandName;
		if (meta.brandCode) brandUpdate.brand_code = meta.brandCode;
		if (Object.keys(brandUpdate).length > 0) {
			const { error: brandErr } = await sb
				.from("broadcasts")
				.update(brandUpdate)
				.eq("id", broadcastId);
			if (brandErr) {
				console.warn(`[snapshot] shopch brand update failed for ${broadcastId}:`, brandErr.message);
			} else {
				brandUpdates++;
			}
		}

		const { error: broadcastErr } = await sb
			.from("broadcasts")
			.update({ video_status: videoStatus })
			.eq("id", broadcastId)
			.eq("video_status", "pending");
		if (broadcastErr) {
			console.warn(`[snapshot] shopch video_status update failed for ${broadcastId}:`, broadcastErr.message);
		} else {
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
	const reportPipelineRunError = (phase: "start" | "settle", error: unknown) => {
		console.warn(`[cron daily-broadcasts] pipeline run ${phase} failed:`, error instanceof Error ? error.message : String(error));
	};
	const pipelineRun = await startPipelineRunBestEffort(
		createPipelineRunRepository(getServiceClient()),
		{
			sourceType: "qvc_shopch",
			jobType: "broadcast_schedule",
			externalRunId: `${targetIso}:${crypto.randomUUID()}`,
			targetScope: { date: targetIso },
		},
		reportPipelineRunError,
	);

	try {

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
		: { snapshotRows: 0, brandUpdates: 0, videoQueued: 0, videoDeferred: 0, categoryBackfilled: 0 };

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
				categoryBackfilled: qvcSnapshot.categoryBackfilled,
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
	const pipelineCounts = dailyBroadcastPipelineCounts({
		inserted: summary.totalInserted,
		updated: summary.totalUpdated,
		sourceErrors: summary.totalErrors,
		enrichmentErrors: enrich.failed,
		processed: summary.results.reduce((total, result) => total + result.slots.length, 0),
	});
	const successfulSources = summary.results.filter((result) => result.ok).length;
	await settlePipelineRunBestEffort(
		pipelineRun,
		async (run) => {
		if (pipelineCounts.failed === 0 && successfulSources === summary.results.length) {
			await run.succeed(pipelineCounts);
		} else if (successfulSources > 0) {
			await run.partial(
					pipelineCounts,
					summary.totalErrors > 0 ? "source_partial" : "enrichment_partial",
					`${summary.totalErrors} source scrape and ${enrich.failed} product enrichment error(s)`,
				);
		} else {
			await failPipelineRunWithKnownCounts(run, pipelineCounts, "source_failed", `${summary.totalErrors} source scrape and ${enrich.failed} product enrichment error(s)`, reportPipelineRunError);
		}
		},
		reportPipelineRunError,
	);

	return NextResponse.json({ ok: true, ...log });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await settlePipelineRunBestEffort(pipelineRun, (run) => run.fail("broadcast_schedule_failed", message), reportPipelineRunError);
		throw err;
	}
}
