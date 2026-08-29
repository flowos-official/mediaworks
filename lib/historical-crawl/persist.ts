import { getServiceClient } from "@/lib/supabase";
import type { HistoricalRow } from "./types";

const BATCH = 500;
const EXISTENCE_LOOKUP_BATCH = 50;

export interface PersistOutcome {
	upserted: number;
	inserted: number;
	updated: number;
	skippedDuplicate: number;
	errors: number;
	/** First upsert error of the run, so the recorded run says WHY nothing landed. */
	firstError?: string;
}

function rowKey(row: Pick<HistoricalRow, "channel" | "air_date" | "product_name">): string {
	return JSON.stringify([row.channel, row.air_date, row.product_name]);
}

function postgrestValue(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function splitRowsByExistingKeys(
	rows: readonly HistoricalRow[],
	existingKeys: ReadonlySet<string>,
): { inserted: number; updated: number } {
	let inserted = 0;
	let updated = 0;
	for (const row of rows) {
		if (existingKeys.has(rowKey(row))) updated++;
		else inserted++;
	}
	return { inserted, updated };
}

async function existingKeysForRows(rows: HistoricalRow[]): Promise<Set<string>> {
	const sb = getServiceClient();
	const existingKeys = new Set<string>();
	for (let i = 0; i < rows.length; i += EXISTENCE_LOOKUP_BATCH) {
		const chunk = rows.slice(i, i + EXISTENCE_LOOKUP_BATCH);
		const filter = chunk
			.map(
				(row) =>
					`and(channel.eq.${postgrestValue(row.channel)},air_date.eq.${postgrestValue(row.air_date)},product_name.eq.${postgrestValue(row.product_name)})`,
			)
			.join(",");
		const { data, error } = await sb
			.from("historical_broadcasts")
			.select("channel,air_date,product_name")
			.or(filter);
		if (error) throw new Error(error.message);
		for (const row of data ?? []) {
			const existing = row as Pick<HistoricalRow, "channel" | "air_date" | "product_name">;
			existingKeys.add(rowKey(existing));
		}
	}
	return existingKeys;
}

/**
 * Upsert rows into historical_broadcasts. The unique constraint
 * (channel, air_date, product_name) deduplicates against existing rows
 * (e.g. from the OA xlsx import). In-batch duplicates are deduped first.
 */
export async function persistRows(rows: HistoricalRow[]): Promise<PersistOutcome> {
	if (rows.length === 0) {
		return { upserted: 0, inserted: 0, updated: 0, skippedDuplicate: 0, errors: 0 };
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
	let inserted = 0;
	let updated = 0;
	let errors = 0;
	let firstError: string | undefined;

	for (let i = 0; i < unique.length; i += BATCH) {
		const slice = unique.slice(i, i + BATCH);
		let existingKeys: Set<string>;
		try {
			existingKeys = await existingKeysForRows(slice);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[persistRows] existence lookup error:", message);
			errors += slice.length;
			firstError ??= message;
			continue;
		}
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
			const affected = count ?? slice.length;
			upserted += affected;
			const split = splitRowsByExistingKeys(slice, existingKeys);
			inserted += split.inserted;
			updated += split.updated;
		}
	}
	return { upserted, inserted, updated, skippedDuplicate, errors, ...(firstError ? { firstError } : {}) };
}

export const __test = { splitRowsByExistingKeys };
