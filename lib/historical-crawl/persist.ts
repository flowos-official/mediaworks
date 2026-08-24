import { getServiceClient } from "@/lib/supabase";
import type { HistoricalRow } from "./types";

const BATCH = 500;

export interface PersistOutcome {
	upserted: number;
	skippedDuplicate: number;
	errors: number;
	/** First upsert error of the run, so the recorded run says WHY nothing landed. */
	firstError?: string;
}

/**
 * Upsert rows into historical_broadcasts. The unique constraint
 * (channel, air_date, product_name) deduplicates against existing rows
 * (e.g. from the OA xlsx import). In-batch duplicates are deduped first.
 */
export async function persistRows(rows: HistoricalRow[]): Promise<PersistOutcome> {
	if (rows.length === 0) {
		return { upserted: 0, skippedDuplicate: 0, errors: 0 };
	}

	const seen = new Set<string>();
	const unique: HistoricalRow[] = [];
	for (const r of rows) {
		const k = r.channel + "|" + r.air_date + "|" + r.product_name;
		if (seen.has(k)) continue;
		seen.add(k);
		unique.push(r);
	}
	const skippedDuplicate = rows.length - unique.length;

	const sb = getServiceClient();
	let upserted = 0;
	let errors = 0;
	let firstError: string | undefined;

	for (let i = 0; i < unique.length; i += BATCH) {
		const slice = unique.slice(i, i + BATCH);
		const { error, count } = await sb
			.from("historical_broadcasts")
			.upsert(slice, {
				onConflict: "channel,air_date,product_name",
				ignoreDuplicates: false,
				count: "exact",
			});
		if (error) {
			console.error("[persistRows] upsert error:", error.message);
			errors += slice.length;
			firstError ??= error.message;
		} else {
			upserted += count ?? slice.length;
		}
	}
	return { upserted, skippedDuplicate, errors, ...(firstError ? { firstError } : {}) };
}
