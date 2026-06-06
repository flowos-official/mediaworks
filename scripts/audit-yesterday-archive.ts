/**
 * Audit yesterday's (JST) video archive coverage.
 *
 * Checks, for QVC + ShopCh broadcasts that aired yesterday (JST):
 *   - per-channel video_status breakdown
 *   - how many actually archived (archived_video_s3 set) + total bytes + when
 *   - any incomplete/failed slots (queued / downloading / abandoned / failed*)
 *   - orphan inconsistencies (archived w/o S3 key, or S3 key w/o archived status)
 *   - 5-day context table
 *
 * Run: tsx --env-file=.env.local scripts/audit-yesterday-archive.ts
 *       (optional) ... scripts/audit-yesterday-archive.ts 2026-06-05   # force date
 */
import { getServiceClient } from "../lib/supabase";

interface Row {
	id: string;
	channel: string;
	air_date: string;
	start_time: string | null;
	program_title: string | null;
	video_status: string | null;
	archived_video_s3: string | null;
	video_size_bytes: number | null;
	video_duration_sec: number | null;
	video_downloaded_at: string | null;
	video_download_attempts: number | null;
	video_error: string | null;
	category: string | null;
	product_ids: string[] | null;
}

const SELECT =
	"id, channel, air_date, start_time, program_title, video_status, archived_video_s3, " +
	"video_size_bytes, video_duration_sec, video_downloaded_at, video_download_attempts, " +
	"video_error, category, product_ids";

// status buckets
const SUCCESS = "archived";
const PENDING = new Set(["queued", "downloading", "pending"]); // not yet done
const FAILURE = new Set(["abandoned", "failed", "failed_unsupported"]); // hard fail
// "deferred" = intentionally no video (or ShopCh 403 not-yet-published)

function jstDateOffset(daysAgo: number): string {
	const ms = Date.now() + 9 * 3600_000 - daysAgo * 86400_000;
	return new Date(ms).toISOString().slice(0, 10);
}

function jstNow(): string {
	return new Date(Date.now() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19) + " JST";
}

function fmtBytes(b: number): string {
	if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
	if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
	return `${b} B`;
}

async function fetchRange(from: string, to: string): Promise<Row[]> {
	const sb = getServiceClient();
	const rows: Row[] = [];
	let offset = 0;
	const PAGE = 1000;
	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select(SELECT)
			.in("channel", ["qvc", "shopch"])
			.gte("air_date", from)
			.lte("air_date", to)
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(error.message);
		if (!data || data.length === 0) break;
		rows.push(...(data as unknown as Row[]));
		if (data.length < PAGE) break;
		offset += PAGE;
	}
	return rows;
}

function statusBreakdown(rows: Row[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const r of rows) m.set(r.video_status ?? "(null)", (m.get(r.video_status ?? "(null)") ?? 0) + 1);
	return m;
}

async function main(): Promise<void> {
	const forced = process.argv[2];
	const targetDate = forced ?? jstDateOffset(1);
	console.log(`Now: ${jstNow()}`);
	console.log(`Auditing air_date = ${targetDate} (yesterday JST)\n`);

	const ctxFrom = jstDateOffset(5);
	const ctxTo = jstDateOffset(0); // include today for context
	const all = await fetchRange(ctxFrom, ctxTo);
	const day = all.filter((r) => r.air_date === targetDate);

	if (day.length === 0) {
		console.log(`⚠ No QVC/ShopCh broadcast rows found for ${targetDate}. Either the daily scrape has not run, or the date is wrong.`);
	}

	// ---- Per-channel breakdown for the target day ----
	for (const ch of ["qvc", "shopch"] as const) {
		const sub = day.filter((r) => r.channel === ch);
		const arch = sub.filter((r) => r.video_status === SUCCESS);
		const archWithKey = arch.filter((r) => r.archived_video_s3);
		const bytes = archWithKey.reduce((s, r) => s + (r.video_size_bytes ?? 0), 0);
		const pending = sub.filter((r) => PENDING.has(r.video_status ?? ""));
		const failed = sub.filter((r) => FAILURE.has(r.video_status ?? ""));
		const deferred = sub.filter((r) => r.video_status === "deferred");

		console.log(`=== ${ch.toUpperCase()} (${targetDate}) — ${sub.length} slots ===`);
		const bd = statusBreakdown(sub);
		console.log(`  status: ${[...bd.entries()].map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);
		console.log(
			`  ✅ archived=${arch.length} (S3 key set=${archWithKey.length})  ${fmtBytes(bytes)}` +
				`  | ⏳ pending=${pending.length}  ❌ failed=${failed.length}  ⏭ deferred=${deferred.length}`,
		);

		// timing: when were they downloaded?
		const times = archWithKey.map((r) => r.video_downloaded_at).filter(Boolean) as string[];
		if (times.length) {
			times.sort();
			console.log(`     downloaded_at range: ${times[0]} → ${times[times.length - 1]}`);
		}
		console.log();
	}

	// ---- Incomplete / failed detail listing ----
	const problems = day.filter(
		(r) => PENDING.has(r.video_status ?? "") || FAILURE.has(r.video_status ?? ""),
	);
	if (problems.length) {
		console.log(`--- ⚠ ${problems.length} INCOMPLETE/FAILED slots on ${targetDate} ---`);
		for (const r of problems.sort((a, b) => (a.channel + a.start_time).localeCompare(b.channel + b.start_time))) {
			console.log(
				`  [${r.channel}] ${r.start_time ?? "--:--"}  ${r.video_status}` +
					`  attempts=${r.video_download_attempts ?? 0}` +
					`  pids=${r.product_ids?.length ?? 0}  cat=${r.category ?? "-"}` +
					`\n      title: ${(r.program_title ?? "").slice(0, 60)}` +
					(r.video_error ? `\n      error: ${r.video_error.slice(0, 140)}` : ""),
			);
		}
		console.log();
	} else {
		console.log(`✅ No queued/downloading/abandoned/failed slots remaining for ${targetDate}.\n`);
	}

	// ---- Deferred detail (distinguish "no video" from "403 not-yet-published") ----
	const deferred = day.filter((r) => r.video_status === "deferred");
	if (deferred.length) {
		const e403 = deferred.filter((r) => /403/.test(r.video_error ?? ""));
		const noUrl = deferred.filter((r) => /no video_url/i.test(r.video_error ?? ""));
		const other = deferred.filter((r) => !e403.includes(r) && !noUrl.includes(r));
		console.log(`--- ⏭ ${deferred.length} deferred on ${targetDate} (no archive expected) ---`);
		console.log(`     no-video-url=${noUrl.length}  403-not-published=${e403.length}  other/no-error=${other.length}`);
		if (e403.length) {
			console.log(`     ⚠ ${e403.length} ShopCh slots deferred on 403 — already aired, should be recoverable. Re-queue candidates:`);
			for (const r of e403.slice(0, 10)) {
				console.log(`        [${r.channel}] ${r.start_time}  ${(r.program_title ?? "").slice(0, 50)}`);
			}
		}
		console.log();
	}

	// ---- Orphan/consistency checks across the whole 5-day window ----
	const orphanNoKey = all.filter((r) => r.video_status === SUCCESS && !r.archived_video_s3);
	const orphanKeyNoStatus = all.filter((r) => r.archived_video_s3 && r.video_status !== SUCCESS);
	console.log(`--- Consistency (last 5 days, ${ctxFrom}..${ctxTo}) ---`);
	console.log(`  archived-but-no-S3-key: ${orphanNoKey.length}${orphanNoKey.length ? "  ⚠ DATA INCONSISTENCY" : ""}`);
	console.log(`  has-S3-key-but-status≠archived: ${orphanKeyNoStatus.length}${orphanKeyNoStatus.length ? "  ⚠ DATA INCONSISTENCY" : ""}`);
	for (const r of [...orphanNoKey, ...orphanKeyNoStatus].slice(0, 10)) {
		console.log(`     [${r.channel}] ${r.air_date} ${r.start_time}  status=${r.video_status}  key=${r.archived_video_s3 ?? "null"}`);
	}
	console.log();

	// ---- 5-day context table ----
	console.log(`--- 5-day context (archived / total, by channel) ---`);
	console.log(`date         qvc(arch/total)  shopch(arch/total)   pending  failed`);
	const dates = [...new Set(all.map((r) => r.air_date))].sort().reverse();
	for (const d of dates) {
		const dr = all.filter((r) => r.air_date === d);
		const q = dr.filter((r) => r.channel === "qvc");
		const sh = dr.filter((r) => r.channel === "shopch");
		const qA = q.filter((r) => r.video_status === SUCCESS).length;
		const shA = sh.filter((r) => r.video_status === SUCCESS).length;
		const pend = dr.filter((r) => PENDING.has(r.video_status ?? "")).length;
		const fail = dr.filter((r) => FAILURE.has(r.video_status ?? "")).length;
		const mark = d === targetDate ? " ←yesterday" : "";
		console.log(
			`${d}   ${String(qA).padStart(3)}/${String(q.length).padEnd(4)}        ${String(shA).padStart(3)}/${String(sh.length).padEnd(4)}` +
				`         ${String(pend).padStart(3)}     ${String(fail).padStart(3)}${mark}`,
		);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
