import { getServiceClient } from "../lib/supabase";
import { buildProgramId, fetchShopChSlotMetadataBatch } from "../lib/broadcasts/shopch-json";

async function main(): Promise<void> {
	const sb = getServiceClient();
	const { data } = await sb
		.from("broadcasts")
		.select("id, air_date, start_time, video_status, archived_video_s3, category, video_error, program_title")
		.eq("channel", "shopch")
		.eq("air_date", "2026-05-21")
		.order("start_time", { ascending: true });

	type Row = { id: string; air_date: string; start_time: string; video_status: string | null; archived_video_s3: string | null; category: string | null; video_error: string | null; program_title: string | null };
	const rows = (data ?? []) as Row[];

	console.log(`5/21 ShopCh slots: ${rows.length}`);
	for (const r of rows) {
		const has = r.archived_video_s3 ? "ARCH" : "----";
		console.log(`  ${r.start_time}  ${(r.video_status ?? "").padEnd(20)} ${has}  cat=${(r.category ?? "(null)").padEnd(20)}  "${(r.program_title ?? "").slice(0, 50)}"`);
	}

	const unarchived = rows.filter((r) => !r.archived_video_s3);
	if (unarchived.length > 0) {
		console.log("\n--- Re-fetch JSON for unarchived ---");
		const pids = unarchived.map((r) => buildProgramId(r.air_date, r.start_time));
		const meta = await fetchShopChSlotMetadataBatch(pids, 3);
		for (const r of unarchived) {
			const pid = buildProgramId(r.air_date, r.start_time);
			const m = meta.get(pid);
			console.log(`  ${r.start_time}  pgmMovie=${m?.videoPath ?? "(unreachable)"}  err=${r.video_error}`);
		}
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
