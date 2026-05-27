/**
 * Safety net for QVC slots that fall through the normal daily cron's
 * enrichQvcSlotSnapshots step — flips whitelist-matching pending slots with
 * a usable lead video_url into 'queued' so the archive cron picks them up.
 *
 * Called automatically at the end of the daily-broadcasts cron so transient
 * partial failures self-heal on the next run.
 *
 * Safe by construction: only touches rows whose current video_status is
 * 'pending', via a CAS update predicate.
 */
import { getServiceClient } from "@/lib/supabase";

const QVC_WHITELIST = new Set([
	"ビューティ", "ファッション", "ホーム・キッチン",
	"レジャー・ホビー", "健康・ダイエット", "家電",
]);

const PAGE = 500;

export interface RecoverResult {
	scanned: number;
	queued: number;
	deferred: number;
	skippedOutOfWhitelist: number;
	skippedNoProduct: number;
}

export async function recoverQvcPending(): Promise<RecoverResult> {
	const sb = getServiceClient();

	let offset = 0;
	let scanned = 0;
	let queued = 0;
	let deferred = 0;
	let skippedOutOfWhitelist = 0;
	let skippedNoProduct = 0;

	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, category, product_ids")
			.eq("channel", "qvc")
			.eq("video_status", "pending")
			.range(offset, offset + PAGE - 1);

		if (error) {
			throw new Error(`recoverQvcPending fetch failed: ${error.message}`);
		}
		if (!data || data.length === 0) break;

		type Row = { id: string; category: string | null; product_ids: string[] | null };
		const rows = data as Row[];
		scanned += rows.length;

		const eligible = rows.filter(
			(r) =>
				r.category &&
				QVC_WHITELIST.has(r.category) &&
				r.product_ids &&
				r.product_ids.length > 0,
		);
		skippedOutOfWhitelist += rows.length - eligible.length;

		if (eligible.length > 0) {
			const leadIds = [
				...new Set(eligible.map((r) => r.product_ids![0])),
			];
			const { data: prods } = await sb
				.from("qvc_products")
				.select("id, video_url, brand")
				.in("id", leadIds);
			const byId = new Map<
				string,
				{ video_url: string | null; brand: string | null }
			>();
			for (const p of (prods ?? []) as Array<{
				id: string;
				video_url: string | null;
				brand: string | null;
			}>) {
				byId.set(p.id, { video_url: p.video_url, brand: p.brand });
			}

			for (const r of eligible) {
				const lead = r.product_ids![0];
				const p = byId.get(lead);
				if (!p) {
					skippedNoProduct += 1;
					continue;
				}
				const nextStatus = p.video_url ? "queued" : "deferred";
				const update: Record<string, string | null> = {
					video_status: nextStatus,
					video_error: null,
				};
				if (p.brand) update.brand_name = p.brand;
				const { error: updErr } = await sb
					.from("broadcasts")
					.update(update)
					.eq("id", r.id)
					.eq("video_status", "pending"); // CAS guard
				if (updErr) {
					console.warn(
						`[qvc-recover] update ${r.id} failed:`,
						updErr.message,
					);
					continue;
				}
				if (nextStatus === "queued") queued += 1;
				else deferred += 1;
			}
		}

		if (data.length < PAGE) break;
		offset += PAGE;
	}

	return {
		scanned,
		queued,
		deferred,
		skippedOutOfWhitelist,
		skippedNoProduct,
	};
}
