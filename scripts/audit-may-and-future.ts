/**
 * Two-part audit:
 *   1. May 2026 archive completeness — per-channel, per-date, and what's left.
 *   2. Forward-looking readiness — for tomorrow's daily cron run, will the
 *      end-to-end pipeline (scrape → enrich → queued → archive) work cleanly?
 *
 * Forward checks:
 *   - 5/27 (today) ShopCh + QVC state — has the daily cron NOT yet run for it?
 *     (cron processes yesterday — so 5/27's slots are processed on 5/28 JST 01:00)
 *   - Make sure today's data either (a) doesn't exist yet, or (b) is already
 *     in 'queued' if it does exist.
 *   - Confirm no anomalies remain in any unprocessed state.
 */
import { getServiceClient } from "../lib/supabase";
import { fetchShopChSlotMetadataBatch, buildProgramId } from "../lib/broadcasts/shopch-json";

const QVC_WHITELIST = new Set([
	"ビューティ", "ファッション", "ホーム・キッチン",
	"レジャー・ホビー", "健康・ダイエット", "家電",
]);

interface Row {
	channel: string;
	air_date: string;
	start_time: string;
	video_status: string | null;
	archived_video_s3: string | null;
	category: string | null;
	product_ids: string[] | null;
}

async function fetchRange(from: string, to: string): Promise<Row[]> {
	const sb = getServiceClient();
	const rows: Row[] = [];
	let offset = 0;
	const PAGE = 1000;
	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("channel, air_date, start_time, video_status, archived_video_s3, category, product_ids")
			.in("channel", ["qvc", "shopch"])
			.gte("air_date", from)
			.lte("air_date", to)
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(error.message);
		if (!data || data.length === 0) break;
		rows.push(...(data as Row[]));
		if (data.length < PAGE) break;
		offset += PAGE;
	}
	return rows;
}

function classifyQvcWhy(r: Row): string {
	if (r.archived_video_s3) return "archived";
	if (!r.category || !QVC_WHITELIST.has(r.category)) return "out-of-whitelist (intentional)";
	if (!r.product_ids || r.product_ids.length === 0) return "no product_ids (data missing)";
	if (r.video_status === "deferred") return "no video on QVC site (genuinely missing)";
	if (r.video_status === "pending") return "ANOMALY: whitelist match but pending";
	return `unexpected status=${r.video_status}`;
}

function classifyShopChWhy(r: Row): string {
	if (r.archived_video_s3) return "archived";
	if (r.video_status === "deferred") return "no pgmMovie (no aired video)";
	return `ANOMALY: status=${r.video_status}`;
}

async function main(): Promise<void> {
	console.log("════════════════════════════════════════════════════════════════════════");
	console.log("PART 1 — May 2026 completeness audit");
	console.log("════════════════════════════════════════════════════════════════════════\n");

	const may = await fetchRange("2026-05-01", "2026-05-31");
	const today = new Date().toISOString().slice(0, 10);
	console.log(`Today (UTC): ${today}\n`);

	for (const ch of ["shopch", "qvc"] as const) {
		const sub = may.filter((r) => r.channel === ch);
		const past = sub.filter((r) => r.air_date < today);
		const future = sub.filter((r) => r.air_date >= today);
		const pastArch = past.filter((r) => r.archived_video_s3).length;

		console.log(`${ch.toUpperCase()}`);
		console.log(`  May total          : ${sub.length}`);
		console.log(`  Past (< ${today}): ${past.length}  archived=${pastArch}  (${past.length ? Math.round(pastArch / past.length * 100) : 100}%)`);
		console.log(`  Future (>= ${today}): ${future.length}  (awaiting daily cron)`);

		// Why are past slots without archive?
		const passWithoutArch = past.filter((r) => !r.archived_video_s3);
		if (passWithoutArch.length > 0) {
			const buckets = new Map<string, number>();
			for (const r of passWithoutArch) {
				const why = ch === "qvc" ? classifyQvcWhy(r) : classifyShopChWhy(r);
				buckets.set(why, (buckets.get(why) ?? 0) + 1);
			}
			console.log(`  Past without ▶ breakdown:`);
			for (const [why, c] of buckets) console.log(`    · ${c.toString().padStart(3)}  ${why}`);
		} else {
			console.log(`  ✅ Past: 100% archived (no slots without ▶)`);
		}
		console.log("");
	}

	// Per-date table for May past dates
	console.log("Per-date (May past dates only):");
	console.log("date         shopch       qvc          notes");
	const pastDates = [...new Set(may.filter((r) => r.air_date < today).map((r) => r.air_date))].sort().reverse();
	for (const d of pastDates) {
		const dRows = may.filter((r) => r.air_date === d);
		const sh = dRows.filter((r) => r.channel === "shopch");
		const q = dRows.filter((r) => r.channel === "qvc");
		const shArch = sh.filter((r) => r.archived_video_s3).length;
		const qArch = q.filter((r) => r.archived_video_s3).length;
		const notes: string[] = [];
		if (sh.length === 0) notes.push("shopch: scraper miss (SSV-only day or cron not run)");
		const qPendingWhitelist = q.filter((r) => !r.archived_video_s3 && r.video_status === "pending" && r.category && QVC_WHITELIST.has(r.category) && r.product_ids?.length);
		if (qPendingWhitelist.length > 0) notes.push(`qvc: ⚠ ${qPendingWhitelist.length} unexpected pending`);
		const note = notes.length > 0 ? "  " + notes.join("; ") : "";
		console.log(`${d}  ${String(shArch).padStart(2)}/${String(sh.length).padEnd(2)}        ${String(qArch).padStart(2)}/${String(q.length).padEnd(2)}        ${note}`);
	}

	console.log("\n════════════════════════════════════════════════════════════════════════");
	console.log("PART 2 — Forward readiness check");
	console.log("════════════════════════════════════════════════════════════════════════\n");

	// Today's slots state — these are what tomorrow's cron will process
	const todayRows = await fetchRange(today, today);
	console.log(`Today (${today}) state — daily cron processes these on JST 01:00 tomorrow:\n`);

	for (const ch of ["shopch", "qvc"] as const) {
		const sub = todayRows.filter((r) => r.channel === ch);
		console.log(`  ${ch.padEnd(8)} count=${sub.length}`);
		if (sub.length > 0) {
			const byStatus = new Map<string, number>();
			for (const r of sub) byStatus.set(r.video_status ?? "(null)", (byStatus.get(r.video_status ?? "(null)") ?? 0) + 1);
			for (const [s, c] of byStatus) console.log(`             ${s.padEnd(22)}: ${c}`);
		}
	}

	// Probe: take ONE shopch slot from today (if any) and run JSON fetch + URL probe
	const todayShopch = todayRows.filter((r) => r.channel === "shopch");
	if (todayShopch.length > 0) {
		console.log(`\n  Simulating archive flow for one of today's ShopCh slots…`);
		const sample = todayShopch[0];
		const pid = buildProgramId(sample.air_date, sample.start_time);
		const meta = await fetchShopChSlotMetadataBatch([pid], 1);
		const m = meta.get(pid);
		const videoUrl = m?.videoPath
			? `https://www.shopch.jp/${m.videoPath}_jwplayer.m3u8`
			: null;
		console.log(`    sample: ${sample.start_time}`);
		console.log(`    JSON pgmMovie: ${m?.videoPath ?? "(none)"}`);
		console.log(`    Derived URL: ${videoUrl ?? "(skip — no pgmMovie)"}`);
		if (videoUrl) {
			const head = await fetch(videoUrl, { method: "HEAD" });
			console.log(`    HEAD ${videoUrl}: ${head.status}  ${head.status === 200 ? "✅ archivable" : "❌ unreachable"}`);
		}
	}

	console.log("\n  Code path tomorrow will follow:");
	console.log("    1. daily-broadcasts cron (JST 01:00) scrapes 5/27 data");
	console.log("    2. enrichQvcSlotSnapshots: whitelist + has-video → queued, otherwise deferred");
	console.log("    3. enrichShopChSlotSnapshots: pgmMovie present → queued, otherwise deferred");
	console.log("    4. archive-videos cron (JST 04:00 + 10:00) pulls queued slots, ffmpeg → S3 → archived");
	console.log("    5. UI shows ▶ on archived rows automatically (no cache invalidation needed for tomorrow's row,");
	console.log("       since the daily cron calls revalidateTag('broadcasts:calendar:YYYY-MM') after writing)");
}

main().catch((e) => { console.error(e); process.exit(1); });
