import { getServiceClient } from "@/lib/supabase";

export interface QvcProductView {
	id: string;
	name: string | null;
	description: string | null;
	image_url: string | null;
	video_url: string | null;
	price_text: string | null;
	source_url: string;
}

interface BroadcastWithProductIds {
	id: string;
	channel: "shopch" | "qvc";
	product_ids: string[] | null;
}

/**
 * Given a list of broadcasts (with product_ids), batch-fetch matching qvc_products rows
 * and return a Map keyed by broadcast id → product views (in the order they appeared in product_ids).
 */
export async function loadProductsForBroadcasts<
	B extends BroadcastWithProductIds,
>(broadcasts: B[]): Promise<Map<string, QvcProductView[]>> {
	const map = new Map<string, QvcProductView[]>();

	const allIds = new Set<string>();
	for (const b of broadcasts) {
		if (b.channel !== "qvc" || !b.product_ids) continue;
		for (const pid of b.product_ids) allIds.add(pid);
	}
	if (allIds.size === 0) return map;

	const sb = getServiceClient();
	const { data, error } = await sb
		.from("qvc_products")
		.select("id,name,description,image_url,video_url,price_text,source_url")
		.in("id", [...allIds]);
	if (error) {
		console.warn("loadProductsForBroadcasts: qvc_products fetch failed", error.message);
		return map;
	}

	const byId = new Map<string, QvcProductView>();
	for (const row of data ?? []) {
		byId.set((row as { id: string }).id, row as QvcProductView);
	}

	for (const b of broadcasts) {
		if (b.channel !== "qvc" || !b.product_ids) continue;
		const views: QvcProductView[] = [];
		for (const pid of b.product_ids) {
			const p = byId.get(pid);
			if (p) views.push(p);
		}
		if (views.length > 0) map.set(b.id, views);
	}
	return map;
}
