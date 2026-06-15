import "server-only";
import { unstable_cacheLife as cacheLife, unstable_cacheTag as cacheTag } from "next/cache";
import { getServiceClient } from "@/lib/supabase";
import { aggregateCalendarCounts, type CountsByDate } from "./aggregate-counts";
import { KEEP_NON_MISDATED_NTV_OR } from "./ntv-suppression";

const OA_CHANNEL_SLUGS = [
	"japanet",
	"junsanpo",
	"ntv",
	"tbs",
	"dinos",
	"senobura",
	"uranoura",
	"txd",
	"ropping",
	"kantv",
] as const;

const TV_CHANNEL_SLUGS = ["qvc", "shopch"] as const;

/**
 * Cached month-window calendar counts. Tag is keyed by the from-date's
 * YYYY-MM; cron routes call `revalidateTag` with the same shape after
 * each scrape. cacheLife is a fail-safe in case a cron skips the
 * invalidation call.
 */
export async function getCachedCalendarCounts(
	from: string,
	to: string,
): Promise<CountsByDate> {
	"use cache";
	cacheTag(`broadcasts:calendar:${from.slice(0, 7)}`);
	cacheLife({ revalidate: 60 * 60 * 6, expire: 60 * 60 * 24 });
	return aggregateCalendarCounts(from, to);
}

/**
 * Cached per-channel total counts (across all dates). Used for the
 * (N) labels on channel chips in the search overlay. Single tag —
 * invalidated whenever any cron adds rows.
 */
export async function getCachedChannelTotals(): Promise<Record<string, number>> {
	"use cache";
	cacheTag("broadcasts:totals");
	cacheLife({ revalidate: 60 * 60 * 6, expire: 60 * 60 * 24 });

	const sb = getServiceClient();

	const tvCounts = await Promise.all(
		TV_CHANNEL_SLUGS.map(async (slug) => {
			const { count } = await sb
				.from("broadcasts")
				.select("id", { count: "exact", head: true })
				.eq("channel", slug);
			return [slug, count ?? 0] as const;
		}),
	);
	const oaCounts = await Promise.all(
		OA_CHANNEL_SLUGS.map(async (slug) => {
			// Hide mis-dated ntv rows from the chip (N) total. No-op for other
			// OA channels (channel.neq.ntv is always true). See ntv-suppression.ts.
			const { count } = await sb
				.from("historical_broadcasts")
				.select("id", { count: "exact", head: true })
				.eq("channel", slug)
				.or(KEEP_NON_MISDATED_NTV_OR);
			return [slug, count ?? 0] as const;
		}),
	);

	return Object.fromEntries([...tvCounts, ...oaCounts]);
}
