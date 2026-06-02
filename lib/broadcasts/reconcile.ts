import { getServiceClient } from "@/lib/supabase";

/**
 * True when a (channel, isoDate) scrape result may delete vanished slots.
 * Strictly future only (never today/past), and only when the fresh scrape
 * actually returned slots (never reconcile against an empty/failed scrape —
 * that would wipe a whole day on a transient upstream error).
 */
export function shouldReconcileDate(
	isoDate: string,
	todayIso: string,
	scrapedSlotCount: number,
): boolean {
	return isoDate > todayIso && scrapedSlotCount > 0;
}

/**
 * Delete broadcasts rows for a strictly-future (channel, isoDate) that are NOT
 * in the freshly-scraped start_time set — i.e. slots QVC/ShopCh rescheduled or
 * cancelled after publishing them ahead of time.
 *
 * Footgun guards (see CLAUDE.md daily:archive footgun):
 *  - caller must gate on shouldReconcileDate (future-only, non-empty);
 *  - archived_video_s3 IS NULL and video_status NOT IN downloading/archived,
 *    so an archived recording can never be deleted (future slots have none, but
 *    this is belt-and-suspenders).
 * Returns the number of rows deleted.
 */
export async function reconcileFutureSlots(
	channel: string,
	isoDate: string,
	keepStartTimes: string[],
): Promise<number> {
	if (keepStartTimes.length === 0) return 0;
	const sb = getServiceClient();
	const keepList = `(${keepStartTimes.map((t) => `"${t}"`).join(",")})`;

	const { data, error } = await sb
		.from("broadcasts")
		.delete()
		.eq("channel", channel)
		.eq("air_date", isoDate)
		.is("archived_video_s3", null)
		.not("video_status", "in", '("downloading","archived")')
		.not("start_time", "in", keepList)
		.select("id");

	if (error) {
		console.warn(`[reconcile] ${channel} ${isoDate} delete failed: ${error.message}`);
		return 0;
	}
	return (data ?? []).length;
}
