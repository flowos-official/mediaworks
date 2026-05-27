import { getServiceClient } from "../lib/supabase";

const QVC_WHITELIST = new Set([
	"ビューティ", "ファッション", "ホーム・キッチン",
	"レジャー・ホビー", "健康・ダイエット", "家電",
]);

async function main(): Promise<void> {
	const sb = getServiceClient();

	// Page through pending QVC May slots
	let offset = 0;
	const PAGE = 500;
	const rows: Array<{ id: string; air_date: string; start_time: string; category: string | null; product_ids: string[] | null }> = [];
	while (true) {
		const { data } = await sb
			.from("broadcasts")
			.select("id, air_date, start_time, category, product_ids")
			.eq("channel", "qvc")
			.eq("video_status", "pending")
			.gte("air_date", "2026-05-01")
			.lte("air_date", "2026-05-31")
			.range(offset, offset + PAGE - 1);
		if (!data || data.length === 0) break;
		rows.push(...(data as typeof rows));
		if (data.length < PAGE) break;
		offset += PAGE;
	}

	console.log(`May QVC pending slots: ${rows.length}`);

	// Bucket by whitelist match
	const inWhitelist = rows.filter((r) => r.category && QVC_WHITELIST.has(r.category));
	const outWhitelist = rows.filter((r) => !r.category || !QVC_WHITELIST.has(r.category));

	console.log(`  in whitelist:  ${inWhitelist.length}  ← these SHOULD be archived, but aren't (cron miss)`);
	console.log(`  out whitelist: ${outWhitelist.length}  ← these are intentionally excluded`);

	// Of the in-whitelist subset, how many have product_ids?
	const withPids = inWhitelist.filter((r) => r.product_ids && r.product_ids.length > 0);
	console.log(`  · with product_ids: ${withPids.length}`);
	console.log(`  · no product_ids:    ${inWhitelist.length - withPids.length}`);

	// Of with-pids, how many have a video_url on lead product
	const leadIds = withPids.map((r) => r.product_ids![0]);
	const uniqLeads = [...new Set(leadIds)];
	const { data: prods } = await sb
		.from("qvc_products")
		.select("id, video_url")
		.in("id", uniqLeads);
	const byId = new Map<string, string | null>();
	for (const p of (prods ?? []) as Array<{ id: string; video_url: string | null }>) byId.set(p.id, p.video_url);

	let withVideo = 0;
	let withoutVideo = 0;
	let noProdRow = 0;
	for (const r of withPids) {
		const lead = r.product_ids![0];
		if (!byId.has(lead)) noProdRow++;
		else if (byId.get(lead)) withVideo++;
		else withoutVideo++;
	}
	console.log(`    · lead has video_url: ${withVideo}   ← recoverable (just need to set queued)`);
	console.log(`    · lead video_url NULL: ${withoutVideo}   ← genuinely no video`);
	console.log(`    · no qvc_products row: ${noProdRow}   ← enrichment skipped`);
}
main().catch((e) => { console.error(e); process.exit(1); });
