/**
 * Recovery for QVC slots stuck in `video_status='pending'` despite being:
 *   - in the channel_categories whitelist, AND
 *   - having a lead product (product_ids[0]) whose qvc_products.video_url is set
 *
 * Root cause: the daily-broadcasts cron's `enrichQvcSlotSnapshots` was added
 * 2026-05-19 — older slots, and slots that fell into a cron's partial-failure
 * window since, never had their video_status flipped from the default 'pending'.
 *
 * This script flips them to 'queued' (along with seeding brand_name from the
 * lead qvc_products row, matching what enrichQvcSlotSnapshots would have done)
 * so the archive-videos cron / drain script picks them up.
 *
 * Safe by construction: only touches rows that are currently 'pending'. Never
 * downgrades an already-archived/queued/downloading slot.
 *
 * Usage: npm run recover:qvc-pending
 */
import { getServiceClient } from "../lib/supabase";

const QVC_WHITELIST = new Set([
	"ビューティ", "ファッション", "ホーム・キッチン",
	"レジャー・ホビー", "健康・ダイエット", "家電",
]);

const PAGE = 500;

async function main(): Promise<void> {
	const sb = getServiceClient();

	let offset = 0;
	let totalScanned = 0;
	let queued = 0;
	let deferred = 0;
	let skippedNoMatch = 0;
	let skippedNoProduct = 0;

	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, air_date, start_time, category, product_ids")
			.eq("channel", "qvc")
			.eq("video_status", "pending")
			.range(offset, offset + PAGE - 1);

		if (error) {
			console.error(`[recover] fetch failed at offset=${offset}:`, error.message);
			process.exit(1);
		}
		if (!data || data.length === 0) break;

		type Row = { id: string; air_date: string; start_time: string; category: string | null; product_ids: string[] | null };
		const rows = data as Row[];
		totalScanned += rows.length;

		const whitelist = rows.filter((r) => r.category && QVC_WHITELIST.has(r.category) && r.product_ids && r.product_ids.length > 0);
		skippedNoMatch += rows.length - whitelist.length;

		const leadIds = [...new Set(whitelist.map((r) => r.product_ids![0]))];
		const { data: prods } = await sb
			.from("qvc_products")
			.select("id, video_url, brand")
			.in("id", leadIds);
		const byId = new Map<string, { video_url: string | null; brand: string | null }>();
		for (const p of (prods ?? []) as Array<{ id: string; video_url: string | null; brand: string | null }>) {
			byId.set(p.id, { video_url: p.video_url, brand: p.brand });
		}

		for (const r of whitelist) {
			const lead = r.product_ids![0];
			const p = byId.get(lead);
			if (!p) {
				skippedNoProduct += 1;
				continue;
			}
			const nextStatus = p.video_url ? "queued" : "deferred";
			const update: Record<string, string | null> = { video_status: nextStatus, video_error: null };
			if (p.brand) update.brand_name = p.brand;
			const { error: updErr } = await sb
				.from("broadcasts")
				.update(update)
				.eq("id", r.id)
				.eq("video_status", "pending"); // CAS: don't overwrite if state changed mid-flight
			if (updErr) {
				console.warn(`[recover] update ${r.id} failed:`, updErr.message);
				continue;
			}
			if (nextStatus === "queued") queued += 1;
			else deferred += 1;
		}

		console.log(`[recover] offset=${offset} scanned=${rows.length} queued=${queued} deferred=${deferred} skipped_no_match=${skippedNoMatch}`);
		if (data.length < PAGE) break;
		offset += PAGE;
	}

	console.log("\n[recover] DONE");
	console.log(`  total scanned        : ${totalScanned}`);
	console.log(`  → queued             : ${queued}`);
	console.log(`  → deferred           : ${deferred}`);
	console.log(`  skipped (not eligible): ${skippedNoMatch}`);
	console.log(`  skipped (no qvc_products row): ${skippedNoProduct}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
