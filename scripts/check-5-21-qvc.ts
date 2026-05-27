import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();

	const { data } = await sb
		.from("broadcasts")
		.select("id, air_date, start_time, video_status, archived_video_s3, category, video_error, program_title, product_ids")
		.eq("channel", "qvc")
		.eq("air_date", "2026-05-21")
		.order("start_time", { ascending: true });

	type Row = {
		id: string; air_date: string; start_time: string;
		video_status: string | null; archived_video_s3: string | null;
		category: string | null; video_error: string | null;
		program_title: string | null; product_ids: string[] | null;
	};
	const rows = (data ?? []) as Row[];

	console.log(`5/21 QVC slots: ${rows.length}`);
	for (const r of rows) {
		const has = r.archived_video_s3 ? "ARCH" : "----";
		console.log(`  ${r.start_time}  ${(r.video_status ?? "").padEnd(12)} ${has}  cat=${(r.category ?? "(null)").padEnd(20)}  pids=${(r.product_ids ?? []).length}  "${(r.program_title ?? "").slice(0, 45)}"`);
	}

	// For unarchived QVC, look up qvc_products.video_url for lead product
	const unarchived = rows.filter((r) => !r.archived_video_s3);
	if (unarchived.length > 0) {
		const leadIds = unarchived.map((r) => r.product_ids?.[0]).filter(Boolean) as string[];
		const { data: prods } = await sb
			.from("qvc_products")
			.select("id, name, video_url")
			.in("id", leadIds);
		const byId = new Map<string, { name: string | null; video_url: string | null }>();
		for (const p of (prods ?? []) as Array<{ id: string; name: string | null; video_url: string | null }>) {
			byId.set(p.id, { name: p.name, video_url: p.video_url });
		}

		console.log("\n--- Lead product video_url state for unarchived ---");
		for (const r of unarchived) {
			const lead = r.product_ids?.[0];
			const p = lead ? byId.get(lead) : null;
			const vu = p?.video_url ? "HAS" : "NULL";
			console.log(`  ${r.start_time}  lead=${lead}  video_url=${vu}  "${p?.name?.slice(0, 40) ?? "(no qvc_products row)"}"`);
		}
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
