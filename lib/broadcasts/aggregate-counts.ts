import { getServiceClient } from "@/lib/supabase";
import { MISDATED_OA_OR_CLAUSES } from "./misdated-suppression";
import { DELISTED_CALENDAR_CHANNELS } from "./channel-style";

const CHUNK_SIZE = 1000;
// Safety stop in case the table grows unexpectedly. 45-day SSR window with
// 12 channels at ~100 events/day per channel is ~54k rows worst case.
const MAX_CHUNKS = 200;

export type CountsByDate = Record<string, Record<string, number>>;

/**
 * Aggregate per-day per-channel broadcast counts across both `broadcasts`
 * (qvc + shopch) and `historical_broadcasts` (10 OA channels). Paginates
 * to bypass the PostgREST row cap that silently truncated wider date
 * windows (May 21 2026 incident: ntv dropped because rows landed past
 * the 10k cap of a single `.range()` call).
 *
 * Uses the service-role client internally. Callers must gate access at
 * their own layer (page-level `requireUser`).
 */
export async function aggregateCalendarCounts(
	from: string,
	to: string,
): Promise<CountsByDate> {
	const sb = getServiceClient();
	const counts: CountsByDate = {};

	const drainTable = async (table: "broadcasts" | "historical_broadcasts") => {
		for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
			const offset = chunk * CHUNK_SIZE;
			let query = sb
				.from(table)
				.select("channel,air_date")
				.gte("air_date", from)
				.lte("air_date", to)
				.order("air_date", { ascending: true })
				.order("channel", { ascending: true })
				.range(offset, offset + CHUNK_SIZE - 1);
			// Hide mis-dated OA rows (ntv/junsanpo/tbs blanket-stamp pollution) and
			// delisted channels (ropping) whose rows are preserved but must not be
			// counted on the calendar. historical_broadcasts only — the broadcasts
			// table has no source_sheet column / OA channels. See
			// misdated-suppression.ts + channel-style.ts::DELISTED_CALENDAR_CHANNELS.
			if (table === "historical_broadcasts") {
				for (const clause of MISDATED_OA_OR_CLAUSES) query = query.or(clause);
				for (const ch of DELISTED_CALENDAR_CHANNELS) query = query.neq("channel", ch);
			}
			const { data, error } = await query;
			if (error || !data) break;
			for (const r of data as Array<{ channel: string; air_date: string }>) {
				const day = (counts[r.air_date] ??= {});
				day[r.channel] = (day[r.channel] ?? 0) + 1;
			}
			if (data.length < CHUNK_SIZE) break;
		}
	};

	await Promise.all([
		drainTable("broadcasts"),
		drainTable("historical_broadcasts"),
	]);

	return counts;
}
