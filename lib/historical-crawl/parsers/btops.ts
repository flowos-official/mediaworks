import type { ChannelParser } from "../types";

/**
 * B-tops closed permanently on 2025-07-31 (see https://www.b-tops.com/).
 * Parser is kept as a no-op so the orchestrator still runs 8 channels;
 * historical data in the OA xlsx (~9512 rows) remains the final record.
 */
export const btopsParser: ChannelParser = {
	slug: "btops",
	name: "読売B-tops",
	fetchToday: async () => [],
};
