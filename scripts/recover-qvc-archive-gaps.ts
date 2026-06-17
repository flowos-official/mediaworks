/**
 * One-shot recovery for the QVC video-archive gap (claims 2 & 3).
 *
 * For QVC slots in the last N days that are NOT archived and stuck in
 * pending/deferred:
 *   1. Backfill a NULL broadcasts.category from the resolved product category
 *      (scans ALL products, not just the lead one).
 *   2. A slot is RECOVERABLE iff its effective category is whitelisted AND some
 *      product has a digest video (shared resolver — same logic the fixed
 *      downloader uses).
 *   3. Requeue recoverable slots: video_status -> 'queued', CAS-guarded to
 *      pending/deferred so archived/downloading/queued rows are NEVER touched
 *      (the 2026-06 178GB footgun was an unguarded reset — see memory).
 *
 * Default is DRY-RUN. Pass --apply to mutate. Drain afterwards with
 * `npm run drain:archive-queue`.
 *
 * Run: tsx --env-file=.env.local scripts/recover-qvc-archive-gaps.ts [--apply] [--days=90]
 */
import { getServiceClient } from "../lib/supabase";
import { loadWhitelist, isAllowed, normalizeCategory } from "../lib/broadcasts/category-filter";
import { pickFirstVideoUrl } from "../lib/broadcasts/qvc-video-resolver";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const daysArg = [...args].find((a) => a.startsWith("--days="))?.slice("--days=".length);
const DAYS = daysArg ? parseInt(daysArg, 10) : 90;

type B = { id: string; air_date: string; start_time: string; category: string | null; product_ids: string[] | null; video_status: string | null; archived_video_s3: string | null };

async function main() {
	const sb = getServiceClient();
	const whitelist = await loadWhitelist();
	const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);
	// Only recover ALREADY-AIRED slots (air_date < today JST). Future/forward
	// slots aren't a gap — the daily cron archives them once their day passes.
	const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

	// QVC slots not archived and still healable (pending/deferred).
	const rows: B[] = [];
	for (let off = 0; ; off += 1000) {
		const { data, error } = await sb.from("broadcasts")
			.select("id,air_date,start_time,category,product_ids,video_status,archived_video_s3")
			.eq("channel", "qvc").gte("air_date", since).lt("air_date", todayJst)
			.is("archived_video_s3", null)
			.in("video_status", ["pending", "deferred"])
			.range(off, off + 999);
		if (error) { console.error("load failed:", error.message); process.exit(1); }
		const batch = (data ?? []) as unknown as B[];
		rows.push(...batch);
		if (batch.length < 1000) break;
	}

	// product video_url + category for all referenced ids
	const pids = [...new Set(rows.flatMap((r) => r.product_ids ?? []))];
	const vid = new Map<string, string | null>();
	const cat = new Map<string, string | null>();
	for (let i = 0; i < pids.length; i += 500) {
		const { data } = await sb.from("qvc_products").select("id,video_url,category").in("id", pids.slice(i, i + 500));
		for (const p of (data ?? []) as { id: string; video_url: string | null; category: string | null }[]) {
			vid.set(p.id, p.video_url); cat.set(p.id, p.category);
		}
	}

	const effCat = (r: B): string | null => {
		if (normalizeCategory(r.category)) return r.category;
		for (const pid of r.product_ids ?? []) { const c = cat.get(pid); if (c) return c; }
		return null;
	};
	const hasVideo = (r: B) => !!pickFirstVideoUrl(r.product_ids, vid);

	let categoryBackfill = 0, requeued = 0, skippedNoVideo = 0, skippedNonWhitelist = 0;
	const recoverList: B[] = [];

	for (const r of rows) {
		const ec = effCat(r);
		if (!isAllowed(whitelist, "qvc", ec)) { skippedNonWhitelist++; continue; }
		if (!hasVideo(r)) { skippedNoVideo++; continue; }
		recoverList.push(r);
		// 1. backfill broadcasts.category if null
		if (!normalizeCategory(r.category) && ec) {
			if (apply) {
				const { data: u } = await sb.from("broadcasts").update({ category: ec }).eq("id", r.id).is("category", null).select("id");
				if (u && u.length > 0) categoryBackfill++;
			} else categoryBackfill++;
		}
		// 2. requeue (CAS: only pending/deferred -> queued)
		if (apply) {
			const { data: u } = await sb.from("broadcasts")
				.update({ video_status: "queued", video_error: null })
				.eq("id", r.id).in("video_status", ["pending", "deferred"]).select("id");
			if (u && u.length > 0) requeued++;
		} else requeued++;
	}

	console.log(`QVC recovery ${apply ? "(APPLIED)" : "(DRY-RUN — pass --apply to mutate)"}  window=${since}…today`);
	console.log(`  candidates scanned (pending/deferred, not archived): ${rows.length}`);
	console.log(`  recoverable (whitelist + has video): ${recoverList.length}`);
	console.log(`    → category backfilled: ${categoryBackfill}`);
	console.log(`    → requeued to 'queued': ${requeued}`);
	console.log(`  skipped non-whitelist: ${skippedNonWhitelist}   skipped no-video: ${skippedNoVideo}`);
	const byStatus = new Map<string, number>();
	for (const r of recoverList) byStatus.set(r.video_status ?? "?", (byStatus.get(r.video_status ?? "?") ?? 0) + 1);
	console.log(`  recoverable by current status: ${JSON.stringify(Object.fromEntries(byStatus))}`);
	console.log(`  sample:`);
	for (const r of recoverList.slice(0, 10)) console.log(`    ${r.air_date} ${r.start_time} status=${r.video_status} cat=${r.category ?? "(null→" + effCat(r) + ")"}`);
	if (!apply) console.log(`\nNo changes made. Re-run with --apply, then: npm run drain:archive-queue`);
}
main().catch((e) => { console.error(e); process.exit(1); });
