import assert from "node:assert/strict";

import {
	enrichQvcSlotSnapshots,
	enrichShopChSlotSnapshots,
	type DailySnapshotEnrichmentRepository,
} from "../lib/broadcasts/daily-snapshot-enrichment";
import { loadWhitelistWithClient } from "../lib/broadcasts/category-filter";
import type { ShopChSlotMetadata } from "../lib/broadcasts/shopch-json";

const whitelist = new Map([
	["qvc", new Set(["家電"])],
	["shopch", new Set(["家電"])],
]);
const broadcastIds = new Map([
	["qvc|2026-08-28|10:00", "broadcast-qvc"],
	["shopch|2026-08-28|11:00", "broadcast-shopch"],
]);

function repository(overrides: Partial<DailySnapshotEnrichmentRepository> = {}): DailySnapshotEnrichmentRepository {
	return {
		async loadQvcProducts() {
			return [{
				id: "qvc-product",
				name: "QVC product",
				image_url: null,
				price_text: "¥10,000",
				brand: "QVC brand",
				original_price_jpy: null,
				sale_label: null,
				video_url: "https://example.test/video.m3u8",
				category: "家電",
			}];
		},
		async repairBroadcastCategory() { return true; },
		async upsertBroadcastProducts() {},
		async updateBroadcastBrand() { return true; },
		async updateBroadcastVideoStatus() { return true; },
		...overrides,
	};
}

async function main(): Promise<void> {
	const whitelistFailureClient = {
		from() {
			return {
				select() { return this; },
				eq: async () => ({ data: null, error: { message: "whitelist relation unavailable" } }),
			};
		},
	};
	await assert.rejects(
		() => loadWhitelistWithClient(whitelistFailureClient as never, true),
		/whitelist relation unavailable/,
		"whitelist query unavailability is surfaced instead of becoming an empty whitelist",
	);

	const lookupFailure = await enrichQvcSlotSnapshots(
		[{ channel: "qvc", air_date: "2026-08-28", start_time: "10:00", product_ids: ["qvc-product"], category: null }],
		broadcastIds,
		whitelist,
		repository({ async loadQvcProducts() { throw new Error("qvc lookup unavailable"); } }),
	);
	assert.deepEqual(lookupFailure.errors, [
		{ channel: "qvc", operation: "qvc_product_lookup", message: "qvc lookup unavailable" },
	]);

	const qvcFailures = await enrichQvcSlotSnapshots(
		[{ channel: "qvc", air_date: "2026-08-28", start_time: "10:00", product_ids: ["qvc-product"], category: null }],
		broadcastIds,
		whitelist,
		repository({
			async repairBroadcastCategory() { throw new Error("category write unavailable"); },
			async upsertBroadcastProducts() { throw new Error("snapshot write unavailable"); },
			async updateBroadcastBrand() { throw new Error("brand write unavailable"); },
			async updateBroadcastVideoStatus() { throw new Error("video write unavailable"); },
		}),
	);
	assert.deepEqual(qvcFailures.errors.map((error) => [error.operation, error.message]), [
		["category_backfill", "category write unavailable"],
		["snapshot_upsert", "snapshot write unavailable"],
		["brand_update", "brand write unavailable"],
		["video_status_update", "video write unavailable"],
	]);
	assert.deepEqual(
		{
			categoryBackfilled: qvcFailures.categoryBackfilled,
			snapshotRows: qvcFailures.snapshotRows,
			brandUpdates: qvcFailures.brandUpdates,
			videoQueued: qvcFailures.videoQueued,
		},
		{ categoryBackfilled: 0, snapshotRows: 0, brandUpdates: 0, videoQueued: 0 },
		"failed writes never inflate successful snapshot counters",
	);

	const shopchMetadata: ShopChSlotMetadata = {
		category: "家電",
		categoryCode: "home",
		productIds: ["shopch-product"],
		products: [{
			productId: "shopch-product",
			name: "ShopCh product",
			imageUrl: null,
			priceJpy: 10_000,
			originalPriceJpy: null,
			discountRate: null,
			saleLabel: null,
			taxIncl: true,
			inStockAtCapture: true,
		}],
		brandName: "ShopCh brand",
		brandCode: "brand-code",
		videoPath: "m3u8/program",
		programTitle: null,
		thumbnailUrl: null,
		presenter: null,
	};
	const shopchFailures = await enrichShopChSlotSnapshots(
		[{ channel: "shopch", air_date: "2026-08-28", start_time: "11:00", category: "家電" }],
		new Map([["202608281100", shopchMetadata]]),
		broadcastIds,
		whitelist,
		repository({
			async upsertBroadcastProducts() { throw new Error("shopch snapshot unavailable"); },
			async updateBroadcastBrand() { throw new Error("shopch brand unavailable"); },
			async updateBroadcastVideoStatus() { throw new Error("shopch video unavailable"); },
		}),
	);
	assert.deepEqual(shopchFailures.errors.map((error) => error.operation), [
		"snapshot_upsert",
		"brand_update",
		"video_status_update",
	]);

	console.log("PASS: daily broadcast enrichment surfaces every data-path failure");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
