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
import { loadWhitelist, isAllowed } from "../lib/broadcasts/category-filter";
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

// ── QVC ─────────────────────────────────────────────────────────────────────

async function backfillQVC(whitelist: Map<string, Set<string>>): Promise<void> {
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

		// Filter to whitelist-matching slots that have at least one product_id
		const eligible = rows.filter(
			(r) =>
				Array.isArray(r.product_ids) &&
				r.product_ids.length > 0 &&
				isAllowed(whitelist, "qvc", r.category),
		);

		if (eligible.length > 0) {
			// Collect all unique product IDs across eligible slots
			const allProductIds = Array.from(
				new Set(eligible.flatMap((r) => r.product_ids as string[])),
			);

			// Fetch qvc_products in one go
			const { data: qvcProductsRaw } = await sb
				.from("qvc_products")
				.select("id, name, image_url, price_text, brand, original_price_jpy, sale_label, video_url")
				.in("id", allProductIds);

			type QvcProductRow = QvcProductLike & { video_url?: string | null };
			const qvcProducts = (qvcProductsRaw ?? []) as QvcProductRow[];
			const byId = new Map<string, QvcProductRow>();
			for (const p of qvcProducts) byId.set(p.id, p);

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

				// Determine brand and video_status
				const brandName = pickBrandFromQvcProducts(pids, slotProducts);
				const firstProduct = byId.get(pids[0]);
				const hasVideo = !!(
					firstProduct?.video_url &&
					(firstProduct.video_url as string).length > 0
				);
				// video_status values 'queued'/'deferred' require the check constraint
				// to be widened first (see supabase/migrations/2026-05-19_broadcasts_video_status_full_enum.sql).
				// Once the migration is applied, uncomment the video_status field below.
				const videoStatus: string = hasVideo ? "queued" : "deferred";
				void videoStatus; // suppress unused warning until migration is applied

				const { error: updateErr } = await sb
					.from("broadcasts")
					.update({
						brand_name: brandName,
						brand_code: null, // QVC has no brand_code field in qvc_products
						// video_status: videoStatus, // blocked: constraint not yet widened
					})
					.eq("id", row.id);
				if (updateErr) {
					console.warn(`[qvc] broadcast update ${row.id} failed:`, updateErr.message);
				}

				qvcUpdated += 1;
			}
		}

		console.log(
			`[qvc] page ${page}: rows=${rows.length} eligible=${eligible.length} updated=${qvcUpdated}`,
		);

		if (data.length < PAGE_SIZE) break;
		offset += PAGE_SIZE;
		page += 1;
	}
}

// ── ShopCh ───────────────────────────────────────────────────────────────────

async function backfillShopCh(whitelist: Map<string, Set<string>>): Promise<void> {
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
				// video_status='failed_unsupported' blocked until constraint widened
				// (see supabase/migrations/2026-05-19_broadcasts_video_status_full_enum.sql)
				const { error: updateErr } = await sb
					.from("broadcasts")
					.update({
						brand_name: meta.brandName,
						brand_code: meta.brandCode,
						// video_status: "failed_unsupported",
					})
					.eq("id", row.id);
				if (updateErr) {
					console.warn(`[shopch] broadcast update ${row.id} failed:`, updateErr.message);
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

(async () => {
	console.log("backfill-broadcast-products: loading whitelist...");
	const whitelist = await loadWhitelist(true);
	console.log(`  whitelist channels: ${[...whitelist.keys()].join(", ")}`);

	console.log("\n=== QVC ===");
	await backfillQVC(whitelist);

	console.log("\n=== ShopCh ===");
	await backfillShopCh(whitelist);

	console.log(
		`\nDone. qvc updated=${qvcUpdated} shopch updated=${shUpdated} shopch skipped=${shSkippedOlder}`,
	);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
