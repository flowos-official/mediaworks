/**
 * ONE-OFF backlog rescue for ShopCh slots stranded in 'pending'.
 *
 * The cron's recoverShopChPending confirms video via the slot JSON (pgmMovie),
 * but that JSON expires for old dates → fetchFailed. The archived m3u8 on
 * CloudFront persists independently, so for the historical backlog we probe the
 * m3u8 directly (HTTP 200/206 = video exists) and requeue those (CAS-guarded).
 *
 *   npx tsx --env-file=.env.local scripts/rescue-shopch-pending-backlog.ts [--apply]
 *   (dry-run by default; pass --apply to actually flip pending→queued)
 */
import { getServiceClient } from "../lib/supabase";
import { loadWhitelist, isAllowed } from "../lib/broadcasts/category-filter";
import { buildProgramId } from "../lib/broadcasts/shopch-json";

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 5;

interface Slot { id: string; air_date: string; start_time: string; program_title: string | null; category: string | null; }

async function probe(slot: Slot): Promise<{ slot: Slot; status: number | null; err?: string }> {
	const pid = buildProgramId(slot.air_date, slot.start_time);
	const url = `https://www.shopch.jp/m3u8/prog/${pid}/${pid}_jwplayer.m3u8`;
	try {
		const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
		return { slot, status: res.status };
	} catch (e) {
		return { slot, status: null, err: e instanceof Error ? e.message : String(e) };
	}
}

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let i = 0;
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
		while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx]); }
	}));
	return out;
}

async function main() {
	const sb = getServiceClient();
	const whitelist = await loadWhitelist(true);
	const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

	const all: Slot[] = [];
	let offset = 0;
	for (;;) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, air_date, start_time, program_title, category")
			.eq("channel", "shopch").eq("video_status", "pending")
			.lt("air_date", today).order("air_date", { ascending: true }).range(offset, offset + 999);
		if (error) throw new Error(error.message);
		if (!data || data.length === 0) break;
		all.push(...(data as unknown as Slot[]));
		if (data.length < 1000) break;
		offset += 1000;
	}
	const eligible = all.filter((s) => s.start_time && isAllowed(whitelist, "shopch", s.category));
	console.log(`past pending shopch: ${all.length}  | whitelist-eligible: ${eligible.length}  | mode: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

	const probed = await mapLimit(eligible, CONCURRENCY, probe);
	const hasVideo = probed.filter((p) => p.status === 200 || p.status === 206);
	const noVideo = probed.filter((p) => p.status === 403);
	const other = probed.filter((p) => p.status !== 200 && p.status !== 206 && p.status !== 403);

	console.log(`m3u8 probe: video-exists(200/206)=${hasVideo.length}  no-video(403)=${noVideo.length}  other/error=${other.length}\n`);
	for (const p of other) console.log(`  other: ${p.slot.air_date} ${p.slot.start_time}  status=${p.status ?? p.err}`);

	let requeued = 0;
	if (APPLY) {
		for (const p of hasVideo) {
			const { error, count } = await sb.from("broadcasts")
				.update({ video_status: "queued", video_error: null }, { count: "exact" })
				.eq("id", p.slot.id).eq("video_status", "pending");
			if (error) { console.warn(`  requeue failed ${p.slot.id}: ${error.message}`); continue; }
			if (count && count > 0) requeued++;
		}
		console.log(`\n✅ requeued ${requeued}/${hasVideo.length} slots (video exists). They will be archived by the drain / next cron.`);
	} else {
		console.log(`(dry-run) would requeue ${hasVideo.length} slots. Re-run with --apply.`);
		const byDate = new Map<string, number>();
		for (const p of hasVideo) byDate.set(p.slot.air_date, (byDate.get(p.slot.air_date) ?? 0) + 1);
		console.log("recoverable by date:");
		for (const [d, c] of [...byDate.entries()].sort()) console.log(`  ${d}  ${c}`);
	}
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
