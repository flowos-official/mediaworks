import { getServiceClient } from "@/lib/supabase";

export interface QvcProductView {
	id: string;
	name: string | null;
	description: string | null;
	image_url: string | null;
	video_url: string | null;
	price_text: string | null;
	source_url: string;
	archived_thumbnail_s3: string | null;
	archived_video_s3: string | null;
}

export interface ShopchProductView {
	id: string;
	name: string | null;
	brand: string | null;
	category: string | null;
	price_jpy: number | null;
	compare_price_jpy: number | null;
	off_rate: number | null;
	image_url: string | null;
	source_url: string;
	archived_thumbnail_s3: string | null;
}

interface BroadcastWithProductIds {
	id: string;
	channel: "shopch" | "qvc";
	product_ids: string[] | null;
}

/**
 * Given a list of broadcasts (with product_ids), batch-fetch matching
 * qvc_products / shopch_products rows and return Maps keyed by broadcast id.
 * Product order matches `product_ids`.
 */
export async function loadProductsForBroadcasts<
	B extends BroadcastWithProductIds,
>(
	broadcasts: B[],
): Promise<{
	qvc: Map<string, QvcProductView[]>;
	shopch: Map<string, ShopchProductView[]>;
}> {
	const qvcMap = new Map<string, QvcProductView[]>();
	const shopchMap = new Map<string, ShopchProductView[]>();

	const qvcIds = new Set<string>();
	const shopchIds = new Set<string>();
	for (const b of broadcasts) {
		if (!b.product_ids) continue;
		const target = b.channel === "qvc" ? qvcIds : shopchIds;
		for (const pid of b.product_ids) target.add(pid);
	}

	const sb = getServiceClient();

	if (qvcIds.size > 0) {
		const { data, error } = await sb
			.from("qvc_products")
			.select(
				"id,name,description,image_url,video_url,price_text,source_url,archived_thumbnail_s3,archived_video_s3",
			)
			.in("id", [...qvcIds]);
		if (error) {
			console.warn("loadProductsForBroadcasts: qvc_products fetch failed", error.message);
		} else {
			const byId = new Map<string, QvcProductView>();
			for (const row of data ?? []) byId.set((row as { id: string }).id, row as QvcProductView);
			for (const b of broadcasts) {
				if (b.channel !== "qvc" || !b.product_ids) continue;
				const views: QvcProductView[] = [];
				for (const pid of b.product_ids) {
					const p = byId.get(pid);
					if (p) views.push(p);
				}
				if (views.length > 0) qvcMap.set(b.id, views);
			}
		}
	}

	if (shopchIds.size > 0) {
		const { data, error } = await sb
			.from("shopch_products")
			.select(
				"id,name,brand,category,price_jpy,compare_price_jpy,off_rate,image_url,source_url,archived_thumbnail_s3",
			)
			.in("id", [...shopchIds]);
		if (error) {
			console.warn("loadProductsForBroadcasts: shopch_products fetch failed", error.message);
		} else {
			const byId = new Map<string, ShopchProductView>();
			for (const row of data ?? []) byId.set((row as { id: string }).id, row as ShopchProductView);
			for (const b of broadcasts) {
				if (b.channel !== "shopch" || !b.product_ids) continue;
				const views: ShopchProductView[] = [];
				for (const pid of b.product_ids) {
					const p = byId.get(pid);
					if (p) views.push(p);
				}
				if (views.length > 0) shopchMap.set(b.id, views);
			}
		}
	}

	return { qvc: qvcMap, shopch: shopchMap };
}
