/**
 * Final audit — comprehensive video archive coverage by channel and date.
 *
 * Outputs:
 *   1. All-time totals by channel + status
 *   2. Per-date coverage for the last 30 days
 *   3. Any unexpected anomalies (e.g. archived rows without archived_video_s3)
 */
import { getServiceClient } from "../lib/supabase";
import { loadWhitelist, isAllowed } from "../lib/broadcasts/category-filter";

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

	// Resolve QVC product video_url + category so the anomaly count reflects
	// reality: a slot has video if ANY product has a digest clip (not just the
	// lead one), and a NULL broadcasts.category is resolved from the product.
	const sb = getServiceClient();
	const whitelist = await loadWhitelist();
	const qvcPids = [...new Set(rows.filter((r) => r.channel === "qvc").flatMap((r) => r.product_ids ?? []))];
	const pVideo = new Map<string, boolean>();
	const pCat = new Map<string, string | null>();
	for (let i = 0; i < qvcPids.length; i += 500) {
		const { data } = await sb.from("qvc_products").select("id,video_url,category").in("id", qvcPids.slice(i, i + 500));
		for (const p of (data ?? []) as { id: string; video_url: string | null; category: string | null }[]) {
			pVideo.set(p.id, !!p.video_url);
			pCat.set(p.id, p.category);
		}
	}
	const anyVideo = (r: Row) => (r.product_ids ?? []).some((pid) => pVideo.get(pid));
	const effCategory = (r: Row): string | null => r.category ?? (r.product_ids ?? []).map((pid) => pCat.get(pid)).find((c) => c) ?? null;

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

		// Anomaly: QVC not archived but a video exists for a whitelist slot.
		// Counts deferred slots (lead product had no digest, a later one does) and
		// resolves a NULL broadcasts.category from the product — the two cases the
		// previous (category && !deferred) filter silently under-reported.
		const qAnomaly = q.filter((r) => {
			if (r.archived_video_s3) return false;
			return isAllowed(whitelist, "qvc", effCategory(r)) && anyVideo(r);
		});
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
