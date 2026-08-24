import { getServiceClient } from "@/lib/supabase";

/** Keep each `in` filter well inside PostgREST's per-response row cap. */
const ID_CHUNK = 400;

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
	// A 62-day calendar range can reference more than 1000 products, and an
	// `in` filter that wide still comes back capped at one page — the slots
	// beyond it would render with no product detail at all.
	const ids = [...allIds];
	const data: QvcProductView[] = [];
	for (let i = 0; i < ids.length; i += ID_CHUNK) {
		const { data: page, error } = await sb
			.from("qvc_products")
			.select("id,name,description,image_url,video_url,price_text,source_url")
			.in("id", ids.slice(i, i + ID_CHUNK));
		if (error) {
			console.warn("loadProductsForBroadcasts: qvc_products fetch failed", error.message);
			return map;
		}
		data.push(...((page ?? []) as unknown as QvcProductView[]));
	}

	const byId = new Map<string, QvcProductView>();
	for (const row of data) {
		byId.set(row.id, row);
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
