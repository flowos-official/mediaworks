/**
 * One-shot historical backfill: populate `broadcast_products` from existing
 * `broadcasts` rows and seed `broadcasts.video_status`.
 *
 * QVC  — looks up qvc_products by product_ids[], builds rows via snapshot-enrichment helpers.
 * ShopCh — refetches the per-slot JSON live; slots older than ~30 days return empty (counted as skipped).
 *
 * After upserting broadcast_products, updates broadcasts.brand_name / brand_code / video_status.
 *
 * Usage:
 *   npm run backfill:broadcast-products
 */
import { getServiceClient } from "../lib/supabase";
import { loadWhitelist, isAllowed, normalizeCategory } from "../lib/broadcasts/category-filter";
import { pickFirstVideoUrl } from "../lib/broadcasts/qvc-video-resolver";
import {
	buildQvcSnapshotRows,
	buildShopChSnapshotRows,
	pickBrandFromQvcProducts,
	type QvcProductLike,
} from "../lib/broadcasts/snapshot-enrichment";
import {
	buildProgramId,
	fetchShopChSlotMetadataBatch,
} from "../lib/broadcasts/shopch-json";
import { sleep } from "../lib/broadcasts/fetch";

const PAGE_SIZE = 200;

// Counters
let qvcUpdated = 0;
let shUpdated = 0;
let shSkippedOlder = 0;

/** Shared state: print the migration warning at most once across the entire run. */
interface WarnCtx { warned: boolean }

// ── QVC ─────────────────────────────────────────────────────────────────────

async function backfillQVC(
	whitelist: Map<string, Set<string>>,
	warnCtx: WarnCtx,
): Promise<void> {
	const sb = getServiceClient();
	let offset = 0;
	let page = 0;

	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, channel, air_date, start_time, category, product_ids")
			.eq("channel", "qvc")
			.range(offset, offset + PAGE_SIZE - 1)
			.order("air_date", { ascending: true });

		if (error) {
			console.error(`[qvc] page ${page} fetch error:`, error.message);
			break;
		}
		if (!data || data.length === 0) break;

		type BroadcastRow = {
			id: string;
			channel: string;
			air_date: string;
			start_time: string | null;
			category: string | null;
			product_ids: string[] | null;
		};
		const rows = data as BroadcastRow[];
		let eligibleCount = 0;

		// Slots with at least one product_id. Whitelist is decided AFTER we fetch
		// product categories, so a NULL broadcasts.category (unenriched at scrape
		// time) can be resolved from the product — matching the daily cron.
		const withPids = rows.filter(
			(r) => Array.isArray(r.product_ids) && r.product_ids.length > 0,
		);

		if (withPids.length > 0) {
			// Collect all unique product IDs across these slots
			const allProductIds = Array.from(
				new Set(withPids.flatMap((r) => r.product_ids as string[])),
			);

			// Fetch qvc_products in one go (incl. category for effective-category resolution)
			const { data: qvcProductsRaw } = await sb
				.from("qvc_products")
				.select("id, name, image_url, price_text, brand, original_price_jpy, sale_label, video_url, category")
				.in("id", allProductIds);

			type QvcProductRow = QvcProductLike & { video_url?: string | null; category?: string | null };
			const qvcProducts = (qvcProductsRaw ?? []) as QvcProductRow[];
			const byId = new Map<string, QvcProductRow>();
			const videoUrlById = new Map<string, string | null>();
			for (const p of qvcProducts) { byId.set(p.id, p); videoUrlById.set(p.id, p.video_url ?? null); }

			// Effective category: slot's own, else first product (in order) with one.
			const effectiveCategory = (r: BroadcastRow): string | null => {
				if (normalizeCategory(r.category)) return r.category;
				for (const pid of r.product_ids ?? []) {
					const c = byId.get(pid)?.category;
					if (c) return c;
				}
				return null;
			};

			const eligible = withPids.filter((r) => isAllowed(whitelist, "qvc", effectiveCategory(r)));
			eligibleCount = eligible.length;

			for (const row of eligible) {
				const pids = row.product_ids as string[];
				const slotProducts = pids.map((id) => byId.get(id)).filter((p): p is QvcProductRow => !!p);

				const bpRows = buildQvcSnapshotRows(row.id, pids, slotProducts);
				if (bpRows.length === 0) continue;

				// Upsert broadcast_products
				const { error: upsertErr } = await sb
					.from("broadcast_products")
					.upsert(bpRows, { onConflict: "broadcast_id,product_id" });
				if (upsertErr) {
					console.warn(`[qvc] upsert ${row.id} failed:`, upsertErr.message);
					continue;
				}

				// Backfill a NULL broadcasts.category from the resolved product
				// category (CAS on category IS NULL) so reconciliation + the UI gate
				// see it. Matches the daily cron.
				const effCat = effectiveCategory(row);
				if (!normalizeCategory(row.category) && effCat) {
					await sb.from("broadcasts").update({ category: effCat }).eq("id", row.id).is("category", null);
				}

				// Determine brand and video_status. hasVideo scans ALL products via
				// the shared resolver — using product_ids[0] only is the lead-product
				// bug that left queued slots re-deferred when this backfill re-ran.
				const brandName = pickBrandFromQvcProducts(pids, slotProducts);
				const hasVideo = !!pickFirstVideoUrl(pids, videoUrlById);
				const videoStatus: string = hasVideo ? "queued" : "deferred";

				const { error: updateErr } = await sb
					.from("broadcasts")
					.update({
						brand_name: brandName,
						brand_code: null, // QVC has no brand_code field in qvc_products
					})
					.eq("id", row.id);
				if (updateErr) {
					console.warn(`[qvc] broadcast update ${row.id} failed:`, updateErr.message);
				}

				// Seed video_status — requires migration 2026-05-19_broadcasts_video_status_full_enum.sql.
				// Guard: never clobber a slot that is already 'archived' (S3 object
				// exists) or mid-flight 'downloading'. Without this, an unscoped
				// backfill resets the entire archived history back to 'queued' and
				// the drain re-downloads videos we already have.
				const { error: vsErr } = await sb
					.from("broadcasts")
					.update({ video_status: videoStatus })
					.eq("id", row.id)
					.not("video_status", "in", "(archived,downloading)");
				if (vsErr) {
					if (vsErr.message.includes("broadcasts_video_status_check")) {
						if (!warnCtx.warned) {
							console.warn(
								"[backfill] video_status update skipped — please apply migration " +
								"2026-05-19_broadcasts_video_status_full_enum.sql",
							);
							warnCtx.warned = true;
						}
					} else {
						console.warn(`[backfill] video_status update failed for ${row.id}:`, vsErr.message);
					}
				}

				qvcUpdated += 1;
			}
		}

		console.log(
			`[qvc] page ${page}: rows=${rows.length} eligible=${eligibleCount} updated=${qvcUpdated}`,
		);

		if (data.length < PAGE_SIZE) break;
		offset += PAGE_SIZE;
		page += 1;
	}
}

// ── ShopCh ───────────────────────────────────────────────────────────────────

async function backfillShopCh(
	whitelist: Map<string, Set<string>>,
	warnCtx: WarnCtx,
): Promise<void> {
	const sb = getServiceClient();
	let offset = 0;
	let page = 0;

	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, channel, air_date, start_time, category")
			.eq("channel", "shopch")
			.range(offset, offset + PAGE_SIZE - 1)
			.order("air_date", { ascending: true });

		if (error) {
			console.error(`[shopch] page ${page} fetch error:`, error.message);
			break;
		}
		if (!data || data.length === 0) break;

		type BroadcastRow = {
			id: string;
			channel: string;
			air_date: string;
			start_time: string | null;
			category: string | null;
		};
		const rows = data as BroadcastRow[];

		// Filter to whitelist-matching slots that have a start_time (needed to build programId)
		const eligible = rows.filter(
			(r) => r.start_time && isAllowed(whitelist, "shopch", r.category),
		);

		for (const row of eligible) {
			try {
				const programId = buildProgramId(row.air_date, row.start_time as string);
				const metaMap = await fetchShopChSlotMetadataBatch([programId], 1);
				const meta = metaMap.get(programId);

				if (!meta || meta.products.length === 0) {
					// Older than ~30 days or fetch failed — slot unavailable
					shSkippedOlder += 1;
					continue;
				}

				const bpRows = buildShopChSnapshotRows(row.id, meta.products);
				if (bpRows.length === 0) {
					shSkippedOlder += 1;
					continue;
				}

				// Upsert broadcast_products
				const { error: upsertErr } = await sb
					.from("broadcast_products")
					.upsert(bpRows, { onConflict: "broadcast_id,product_id" });
				if (upsertErr) {
					console.warn(`[shopch] upsert ${row.id} failed:`, upsertErr.message);
					shSkippedOlder += 1;
					continue;
				}

				// Update broadcasts with brand info
				const { error: updateErr } = await sb
					.from("broadcasts")
					.update({
						brand_name: meta.brandName,
						brand_code: meta.brandCode,
					})
					.eq("id", row.id);
				if (updateErr) {
					console.warn(`[shopch] broadcast update ${row.id} failed:`, updateErr.message);
				}

				// Seed video_status — requires migration 2026-05-19_broadcasts_video_status_full_enum.sql.
				// pgmMovie (meta.videoPath) presence ⇒ aired-program video exists on shopch.jp.
				// Guard: never clobber 'archived' (S3 object exists) or 'downloading'
				// (mid-flight) — see the QVC branch above for the rationale.
				const shVideoStatus = meta.videoPath ? "queued" : "deferred";
				const { error: vsErr } = await sb
					.from("broadcasts")
					.update({ video_status: shVideoStatus })
					.eq("id", row.id)
					.not("video_status", "in", "(archived,downloading)");
				if (vsErr) {
					if (vsErr.message.includes("broadcasts_video_status_check")) {
						if (!warnCtx.warned) {
							console.warn(
								"[backfill] video_status update skipped — please apply migration " +
								"2026-05-19_broadcasts_video_status_full_enum.sql",
							);
							warnCtx.warned = true;
						}
					} else {
						console.warn(`[backfill] video_status update failed for ${row.id}:`, vsErr.message);
					}
				}

				shUpdated += 1;
			} catch (e) {
				console.warn(`[shopch] slot ${row.id} error:`, e instanceof Error ? e.message : String(e));
				shSkippedOlder += 1;
			}

			// Polite pacing between ShopCh requests
			await sleep(300);
		}

		console.log(
			`[shopch] page ${page}: rows=${rows.length} eligible=${eligible.length} updated=${shUpdated} skipped=${shSkippedOlder}`,
		);

		if (data.length < PAGE_SIZE) break;
		offset += PAGE_SIZE;
		page += 1;
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const warnCtx: WarnCtx = { warned: false };

	console.log("backfill-broadcast-products: loading whitelist...");
	const whitelist = await loadWhitelist(true);
	console.log(`  whitelist channels: ${[...whitelist.keys()].join(", ")}`);

	console.log("\n=== QVC ===");
	await backfillQVC(whitelist, warnCtx);

	console.log("\n=== ShopCh ===");
	await backfillShopCh(whitelist, warnCtx);

	console.log(
		`\nDone. qvc updated=${qvcUpdated} shopch updated=${shUpdated} shopch skipped=${shSkippedOlder}`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
