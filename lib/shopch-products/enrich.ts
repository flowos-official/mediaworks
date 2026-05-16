import { getServiceClient } from "@/lib/supabase";
import { sleep } from "@/lib/broadcasts/fetch";
import { fetchSlot } from "./fetch";

export interface EnrichShopchResult {
	slots_processed: number;
	products_upserted: number;
	broadcasts_updated: number;
	errors: string[];
}

export interface EnrichShopchOptions {
	/** Only process broadcasts on these dates (YYYY-MM-DD). Default: all rows lacking product_ids. */
	onlyDates?: string[];
	/** Cap slots in this run. Default unlimited. */
	limit?: number;
	/** Concurrent in-flight fetches. Default 3 (clamped 1..6). */
	concurrency?: number;
	/** Sleep ms between chunks. Default 500. */
	chunkPauseMs?: number;
	onProgress?: (msg: string) => void;
}

interface ShopchBroadcastRow {
	id: string;
	air_date: string;
	start_time: string;
	product_ids: string[] | null;
}

async function collectSlots(opts: EnrichShopchOptions): Promise<ShopchBroadcastRow[]> {
	const sb = getServiceClient();
	let q = sb
		.from("broadcasts")
		.select("id, air_date, start_time, product_ids")
		.eq("channel", "shopch")
		.order("air_date", { ascending: false })
		.order("start_time", { ascending: true });
	if (opts.onlyDates && opts.onlyDates.length > 0) {
		q = q.in("air_date", opts.onlyDates);
	} else {
		q = q.is("product_ids", null);
	}
	if (opts.limit) q = q.limit(opts.limit);
	const { data, error } = await q;
	if (error) throw new Error(`collectSlots: ${error.message}`);
	return (data ?? []) as ShopchBroadcastRow[];
}

export async function enrichShopchProducts(
	opts: EnrichShopchOptions = {},
): Promise<EnrichShopchResult> {
	const sb = getServiceClient();
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
	const pause = opts.chunkPauseMs ?? 500;
	const onProgress = opts.onProgress ?? (() => {});

	const slots = await collectSlots(opts);
	onProgress(`Processing ${slots.length} Shop Channel slots...`);

	let productsUpserted = 0;
	let broadcastsUpdated = 0;
	const errors: string[] = [];

	for (let i = 0; i < slots.length; i += concurrency) {
		const chunk = slots.slice(i, i + concurrency);
		const results = await Promise.all(
			chunk.map(async (slot) => {
				const parsed = await fetchSlot(slot.air_date, slot.start_time);
				return { slot, parsed };
			}),
		);

		// Build the rows we want to upsert / update.
		const productRows: Array<Record<string, unknown>> = [];
		const broadcastUpdates: Array<{ id: string; product_ids: string[] }> = [];
		for (const { slot, parsed } of results) {
			if (!parsed) {
				errors.push(`slot ${slot.air_date} ${slot.start_time}: fetch/parse failed`);
				continue;
			}
			for (const p of parsed.products) {
				productRows.push({
					id: p.id,
					name: p.name,
					brand: p.brand,
					category: p.category,
					price_jpy: p.price_jpy,
					compare_price_jpy: p.compare_price_jpy,
					off_rate: p.off_rate,
					image_url: p.image_url,
					source_url: p.source_url,
					last_seen_at: new Date().toISOString(),
					fetched_at: new Date().toISOString(),
				});
			}
			if (parsed.products.length > 0) {
				broadcastUpdates.push({
					id: slot.id,
					product_ids: parsed.products.map((p) => p.id),
				});
			}
		}

		if (productRows.length > 0) {
			// Same product can appear across multiple slots in one chunk — dedupe
			// by id (keep the latest occurrence) to avoid Postgres' "ON CONFLICT
			// DO UPDATE command cannot affect row a second time" error.
			const byId = new Map<string, Record<string, unknown>>();
			for (const r of productRows) byId.set(r.id as string, r);
			const uniqueRows = Array.from(byId.values());
			const { error } = await sb
				.from("shopch_products")
				.upsert(uniqueRows, { onConflict: "id" });
			if (error) errors.push(`upsert shopch_products: ${error.message}`);
			else productsUpserted += uniqueRows.length;
		}
		for (const upd of broadcastUpdates) {
			const { error } = await sb
				.from("broadcasts")
				.update({ product_ids: upd.product_ids })
				.eq("id", upd.id);
			if (error) errors.push(`update broadcasts ${upd.id}: ${error.message}`);
			else broadcastsUpdated++;
		}

		onProgress(
			`[${Math.min(i + concurrency, slots.length)}/${slots.length}] upserted=${productsUpserted} broadcasts=${broadcastsUpdated} errors=${errors.length}`,
		);
		if (i + concurrency < slots.length) await sleep(pause);
	}

	return {
		slots_processed: slots.length,
		products_upserted: productsUpserted,
		broadcasts_updated: broadcastsUpdated,
		errors,
	};
}
