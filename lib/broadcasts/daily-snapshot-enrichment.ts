import type { SupabaseClient } from "@supabase/supabase-js";

import { getServiceClient } from "@/lib/supabase";
import { isAllowed, normalizeCategory } from "./category-filter";
import {
	buildQvcSnapshotRows,
	buildShopChSnapshotRows,
	pickBrandFromQvcProducts,
	type BroadcastProductRow,
	type QvcProductLike,
} from "./snapshot-enrichment";
import { buildProgramId, type ShopChSlotMetadata } from "./shopch-json";

export type DailySnapshotOperation =
	| "qvc_product_lookup"
	| "category_backfill"
	| "snapshot_upsert"
	| "brand_update"
	| "video_status_update";

export interface DailySnapshotEnrichmentError {
	channel: "qvc" | "shopch";
	operation: DailySnapshotOperation;
	broadcastId?: string;
	message: string;
}

export interface DailySnapshotEnrichmentResult {
	snapshotRows: number;
	brandUpdates: number;
	videoQueued: number;
	videoDeferred: number;
	categoryBackfilled: number;
	errors: DailySnapshotEnrichmentError[];
}

export type QvcSnapshotProduct = QvcProductLike & {
	video_url?: string | null;
	category?: string | null;
};

export interface DailySnapshotEnrichmentRepository {
	loadQvcProducts(productIds: string[]): Promise<QvcSnapshotProduct[]>;
	repairBroadcastCategory(broadcastId: string, currentCategory: string | null, category: string): Promise<boolean>;
	upsertBroadcastProducts(rows: BroadcastProductRow[]): Promise<void>;
	updateBroadcastBrand(broadcastId: string, patch: Record<string, string | null>): Promise<boolean>;
	updateBroadcastVideoStatus(broadcastId: string, status: "queued" | "deferred"): Promise<boolean>;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function emptyResult(): DailySnapshotEnrichmentResult {
	return {
		snapshotRows: 0,
		brandUpdates: 0,
		videoQueued: 0,
		videoDeferred: 0,
		categoryBackfilled: 0,
		errors: [],
	};
}

export function createDailySnapshotEnrichmentRepository(
	sb: SupabaseClient = getServiceClient(),
): DailySnapshotEnrichmentRepository {
	return {
		async loadQvcProducts(productIds) {
			const { data, error } = await sb
				.from("qvc_products")
				.select("id,name,image_url,price_text,brand,original_price_jpy,sale_label,video_url,category")
				.in("id", productIds);
			if (error) throw new Error(`qvc_products lookup failed: ${error.message}`);
			if (!data) throw new Error("qvc_products lookup returned no data");
			return data as QvcSnapshotProduct[];
		},
		async repairBroadcastCategory(broadcastId, currentCategory, category) {
			let query = sb
				.from("broadcasts")
				.update({ category })
				.eq("id", broadcastId);
			query = currentCategory === null
				? query.is("category", null)
				: query.eq("category", currentCategory);
			const { data, error } = await query.select("id");
			if (error) throw new Error(`broadcast category backfill failed: ${error.message}`);
			return (data ?? []).length > 0;
		},
		async upsertBroadcastProducts(rows) {
			const { error } = await sb
				.from("broadcast_products")
				.upsert(rows, { onConflict: "broadcast_id,product_id" });
			if (error) throw new Error(`broadcast product snapshot upsert failed: ${error.message}`);
		},
		async updateBroadcastBrand(broadcastId, patch) {
			const { data, error } = await sb
				.from("broadcasts")
				.update(patch)
				.eq("id", broadcastId)
				.select("id");
			if (error) throw new Error(`broadcast brand update failed: ${error.message}`);
			return (data ?? []).length > 0;
		},
		async updateBroadcastVideoStatus(broadcastId, status) {
			const { data, error } = await sb
				.from("broadcasts")
				.update({ video_status: status })
				.eq("id", broadcastId)
				.eq("video_status", "pending")
				.select("id");
			if (error) throw new Error(`broadcast video status update failed: ${error.message}`);
			return (data ?? []).length > 0;
		},
	};
}

function pushError(
	result: DailySnapshotEnrichmentResult,
	input: Omit<DailySnapshotEnrichmentError, "message">,
	error: unknown,
): void {
	result.errors.push({ ...input, message: message(error) });
}

export async function enrichQvcSlotSnapshots(
	qvcSlots: Array<{ channel: string; air_date: string; start_time: string; product_ids: string[] | null; category: string | null }>,
	broadcastIdMap: Map<string, string>,
	whitelist: Map<string, Set<string>>,
	repository: DailySnapshotEnrichmentRepository = createDailySnapshotEnrichmentRepository(),
): Promise<DailySnapshotEnrichmentResult> {
	const result = emptyResult();
	const slotsWithProducts = qvcSlots.filter((slot) => slot.product_ids && slot.product_ids.length > 0);
	if (slotsWithProducts.length === 0) return result;

	let products: QvcSnapshotProduct[];
	try {
		products = await repository.loadQvcProducts([...new Set(slotsWithProducts.flatMap((slot) => slot.product_ids ?? []))]);
	} catch (error) {
		pushError(result, { channel: "qvc", operation: "qvc_product_lookup" }, error);
		return result;
	}
	const categoryById = new Map(products.map((product) => [product.id, product.category ?? null]));
	const effectiveCategory = (slot: { category: string | null; product_ids: string[] | null }): string | null => {
		if (normalizeCategory(slot.category)) return slot.category;
		for (const productId of slot.product_ids ?? []) {
			const category = categoryById.get(productId);
			if (category) return category;
		}
		return null;
	};

	for (const slot of slotsWithProducts.filter((candidate) => isAllowed(whitelist, "qvc", effectiveCategory(candidate)))) {
		const broadcastId = broadcastIdMap.get(`${slot.channel}|${slot.air_date}|${slot.start_time}`);
		if (!broadcastId) continue;
		const category = effectiveCategory(slot);
		if (!normalizeCategory(slot.category) && category) {
			try {
				if (await repository.repairBroadcastCategory(broadcastId, slot.category, category)) result.categoryBackfilled++;
			} catch (error) {
				pushError(result, { channel: "qvc", operation: "category_backfill", broadcastId }, error);
			}
		}

		const productIds = slot.product_ids ?? [];
		const slotProducts = products.filter((product) => productIds.includes(product.id));
		const rows = buildQvcSnapshotRows(broadcastId, productIds, slotProducts);
		if (rows.length > 0) {
			try {
				await repository.upsertBroadcastProducts(rows);
				result.snapshotRows += rows.length;
			} catch (error) {
				pushError(result, { channel: "qvc", operation: "snapshot_upsert", broadcastId }, error);
			}
		}

		const brand = pickBrandFromQvcProducts(productIds, slotProducts);
		if (brand) {
			try {
				if (await repository.updateBroadcastBrand(broadcastId, { brand_name: brand })) result.brandUpdates++;
			} catch (error) {
				pushError(result, { channel: "qvc", operation: "brand_update", broadcastId }, error);
			}
		}
		const hasVideo = slotProducts.some((product) => product.video_url);
		try {
			if (await repository.updateBroadcastVideoStatus(broadcastId, hasVideo ? "queued" : "deferred")) {
				if (hasVideo) result.videoQueued++;
				else result.videoDeferred++;
			}
		} catch (error) {
			pushError(result, { channel: "qvc", operation: "video_status_update", broadcastId }, error);
		}
	}
	return result;
}

export async function enrichShopChSlotSnapshots(
	shopchSlots: Array<{ channel: string; air_date: string; start_time: string; category: string | null }>,
	shopchMetadataByProgramId: Map<string, ShopChSlotMetadata>,
	broadcastIdMap: Map<string, string>,
	whitelist: Map<string, Set<string>>,
	repository: DailySnapshotEnrichmentRepository = createDailySnapshotEnrichmentRepository(),
): Promise<DailySnapshotEnrichmentResult> {
	const result = emptyResult();
	for (const slot of shopchSlots) {
		if (!isAllowed(whitelist, "shopch", slot.category)) continue;
		const metadata = shopchMetadataByProgramId.get(buildProgramId(slot.air_date, slot.start_time));
		if (!metadata || metadata.products.length === 0) continue;
		const broadcastId = broadcastIdMap.get(`${slot.channel}|${slot.air_date}|${slot.start_time}`);
		if (!broadcastId) continue;

		const rows = buildShopChSnapshotRows(broadcastId, metadata.products);
		if (rows.length > 0) {
			try {
				await repository.upsertBroadcastProducts(rows);
				result.snapshotRows += rows.length;
			} catch (error) {
				pushError(result, { channel: "shopch", operation: "snapshot_upsert", broadcastId }, error);
			}
		}

		const brandPatch: Record<string, string | null> = {};
		if (metadata.brandName) brandPatch.brand_name = metadata.brandName;
		if (metadata.brandCode) brandPatch.brand_code = metadata.brandCode;
		if (Object.keys(brandPatch).length > 0) {
			try {
				if (await repository.updateBroadcastBrand(broadcastId, brandPatch)) result.brandUpdates++;
			} catch (error) {
				pushError(result, { channel: "shopch", operation: "brand_update", broadcastId }, error);
			}
		}

		const hasVideo = Boolean(metadata.videoPath);
		try {
			if (await repository.updateBroadcastVideoStatus(broadcastId, hasVideo ? "queued" : "deferred")) {
				if (hasVideo) result.videoQueued++;
				else result.videoDeferred++;
			}
		} catch (error) {
			pushError(result, { channel: "shopch", operation: "video_status_update", broadcastId }, error);
		}
	}
	return result;
}
