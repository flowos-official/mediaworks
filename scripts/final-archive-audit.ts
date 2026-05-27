/**
 * Final audit — comprehensive video archive coverage by channel and date.
 *
 * Outputs:
 *   1. All-time totals by channel + status
 *   2. Per-date coverage for the last 30 days
 *   3. Any unexpected anomalies (e.g. archived rows without archived_video_s3)
 */
import { getServiceClient } from "../lib/supabase";

const QVC_WHITELIST = new Set([
	"ビューティ", "ファッション", "ホーム・キッチン",
	"レジャー・ホビー", "健康・ダイエット", "家電",
]);

interface Row {
	channel: string;
	air_date: string;
	video_status: string | null;
	archived_video_s3: string | null;
	category: string | null;
	product_ids: string[] | null;
}

async function pageAll(): Promise<Row[]> {
	const sb = getServiceClient();
	const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
	const rows: Row[] = [];
	let offset = 0;
	const PAGE = 1000;
	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("channel, air_date, video_status, archived_video_s3, category, product_ids")
			.in("channel", ["qvc", "shopch"])
			.gte("air_date", since)
			.range(offset, offset + PAGE - 1);
		if (error) throw new Error(error.message);
		if (!data || data.length === 0) break;
		rows.push(...(data as Row[]));
		if (data.length < PAGE) break;
		offset += PAGE;
	}
	return rows;
}

async function main(): Promise<void> {
	const rows = await pageAll();
	console.log(`=== Last 30 days: ${rows.length} broadcast rows ===\n`);

	// All-time totals (last 30 days) per channel
	for (const ch of ["shopch", "qvc"] as const) {
		const sub = rows.filter((r) => r.channel === ch);
		const arch = sub.filter((r) => r.archived_video_s3).length;
		const ratio = sub.length === 0 ? "—" : `${Math.round((arch / sub.length) * 100)}%`;
		console.log(`${ch.padEnd(8)}  total=${sub.length}  archived=${arch}  (${ratio})`);
		const byStatus = new Map<string, number>();
		for (const r of sub.filter((x) => !x.archived_video_s3)) byStatus.set(r.video_status ?? "(null)", (byStatus.get(r.video_status ?? "(null)") ?? 0) + 1);
		for (const [s, c] of byStatus) console.log(`           · ${s}: ${c}`);
	}

	// Per-date coverage (last 30 days)
	console.log("\n--- Per-date coverage ---");
	console.log("date        shopch (arch/total)   qvc (arch/total)   qvc-in-whitelist-but-not-arch");

	const dates = [...new Set(rows.map((r) => r.air_date))].sort().reverse();
	let anomalyCount = 0;
	for (const d of dates) {
		const dRows = rows.filter((r) => r.air_date === d);
		const sh = dRows.filter((r) => r.channel === "shopch");
		const q = dRows.filter((r) => r.channel === "qvc");
		const shArch = sh.filter((r) => r.archived_video_s3).length;
		const qArch = q.filter((r) => r.archived_video_s3).length;

		// Anomaly: QVC in whitelist + product_ids present but not archived
		const qAnomaly = q.filter((r) =>
			!r.archived_video_s3 &&
			r.category && QVC_WHITELIST.has(r.category) &&
			r.product_ids && r.product_ids.length > 0 &&
			r.video_status !== "deferred",
		);
		anomalyCount += qAnomaly.length;
		const marker = qAnomaly.length > 0 ? `  ⚠ ${qAnomaly.length}` : "";
		console.log(`${d}  ${String(shArch).padStart(3)}/${String(sh.length).padEnd(3)}              ${String(qArch).padStart(3)}/${String(q.length).padEnd(3)}${marker}`);
	}

	console.log(`\nAnomalies (QVC whitelist+pids but not archived): ${anomalyCount}`);
	if (anomalyCount === 0) {
		console.log("✅ No recoverable QVC slots remaining — all whitelist matches with video are archived.");
	}

	// Also check for orphan rows: status=archived but archived_video_s3 NULL (bad state)
	const orphans = rows.filter((r) => r.video_status === "archived" && !r.archived_video_s3);
	if (orphans.length > 0) {
		console.log(`\n⚠ ORPHAN ROWS: ${orphans.length} have status=archived but no S3 key (data inconsistency).`);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
