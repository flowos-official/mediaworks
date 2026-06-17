/**
 * Read-only operational analysis of the QVC video-archive gap.
 * Joins broadcasts.product_ids → qvc_products.{video_url,category} to quantify:
 *  - slots not archived, by video_status
 *  - whitelist vs category-null vs non-whitelist
 *  - ANY product has video_url vs FIRST product has video_url
 *    (the queue-vs-download mismatch: queued on ANY, downloaded on FIRST)
 */
import { getServiceClient } from "../lib/supabase";
import { loadWhitelist, isAllowed } from "../lib/broadcasts/category-filter";

async function main() {
	const sb = getServiceClient();
	const whitelist = await loadWhitelist();

	// pull all QVC broadcasts (last 90 days to bound)
	const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
	type B = { id: string; air_date: string; start_time: string; category: string | null; product_ids: string[] | null; video_status: string | null; archived_video_s3: string | null };
	const rows: B[] = [];
	for (let off = 0; ; off += 1000) {
		const { data, error } = await sb.from("broadcasts")
			.select("id,air_date,start_time,category,product_ids,video_status,archived_video_s3")
			.eq("channel", "qvc").gte("air_date", since).range(off, off + 999);
		if (error) { console.log("ERR", error.message); return; }
		const batch = (data ?? []) as unknown as B[];
		rows.push(...batch);
		if (batch.length < 1000) break;
	}

	// all referenced product ids → video_url + category
	const allPids = [...new Set(rows.flatMap((r) => r.product_ids ?? []))];
	const vid = new Map<string, string | null>();
	const cat = new Map<string, string | null>();
	for (let i = 0; i < allPids.length; i += 500) {
		const slice = allPids.slice(i, i + 500);
		const { data } = await sb.from("qvc_products").select("id,video_url,category").in("id", slice);
		for (const p of (data ?? []) as { id: string; video_url: string | null; category: string | null }[]) {
			vid.set(p.id, p.video_url);
			cat.set(p.id, p.category);
		}
	}

	const anyVideo = (r: B) => (r.product_ids ?? []).some((pid) => vid.get(pid));
	const firstVideo = (r: B) => { const f = r.product_ids?.[0]; return f ? !!vid.get(f) : false; };
	const wlClass = (r: B): "whitelist" | "null" | "nonwhitelist" => {
		if (!r.category) return "null";
		return isAllowed(whitelist, "qvc", r.category) ? "whitelist" : "nonwhitelist";
	};

	const notArchived = rows.filter((r) => !r.archived_video_s3 && r.video_status !== "archived");
	console.log(`QVC since ${since}: ${rows.length} slots, ${rows.length - notArchived.length} archived, ${notArchived.length} not archived\n`);

	// breakdown: AIRED (air_date < today JST), not-archived, has ANY product video.
	// Future/forward slots are excluded — they aren't a gap yet (the daily cron
	// archives them once their day passes), so counting them inflates the gap.
	const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
	const gap = notArchived.filter((r) => r.air_date < todayJst && anyVideo(r));
	console.log(`Aired, not archived, >=1 product has video_url: ${gap.length} (future slots excluded)`);
	const byClass = { whitelist: 0, null: 0, nonwhitelist: 0 };
	const firstHas = { yes: 0, no: 0 };
	const byStatus = new Map<string, number>();
	const nullCatWithVideo: B[] = [];
	const wlFirstNoVideo: B[] = [];
	for (const r of gap) {
		byClass[wlClass(r)]++;
		if (firstVideo(r)) firstHas.yes++; else firstHas.no++;
		byStatus.set(r.video_status ?? "(null)", (byStatus.get(r.video_status ?? "(null)") ?? 0) + 1);
		if (wlClass(r) === "null") nullCatWithVideo.push(r);
		if (wlClass(r) === "whitelist" && !firstVideo(r)) wlFirstNoVideo.push(r);
	}
	console.log("  by whitelist-class:", JSON.stringify(byClass));
	console.log("  first product has video?:", JSON.stringify(firstHas), "  <-- 'no' = queue/download mismatch victims");
	console.log("  by video_status:", JSON.stringify(Object.fromEntries(byStatus)));

	console.log(`\n[A] whitelist + not-archived + has-video but FIRST product has NO video (the deferred-mismatch pattern): ${wlFirstNoVideo.length}`);
	for (const r of wlFirstNoVideo.slice(0, 8)) console.log(`     ${r.air_date} ${r.start_time} status=${r.video_status} cat=${r.category} pids=${(r.product_ids ?? []).length}`);

	console.log(`\n[B] category=NULL + not-archived + has-video (excluded by fail-closed whitelist): ${nullCatWithVideo.length}`);
	for (const r of nullCatWithVideo.slice(0, 8)) {
		// would it become whitelist if we backfilled category from product?
		const pc = (r.product_ids ?? []).map((p) => cat.get(p)).find((c) => c);
		console.log(`     ${r.air_date} ${r.start_time} status=${r.video_status} broadcastCat=null productCat=${pc ?? "?"} pids=${(r.product_ids ?? []).length}`);
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
