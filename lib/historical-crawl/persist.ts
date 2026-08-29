import { getServiceClient } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HistoricalRow } from "./types";

const BATCH = 500;
const EXISTENCE_LOOKUP_PAGE_SIZE = 1_000;
const EXISTENCE_LOOKUP_DATE_BATCH = 31;

export interface PersistOutcome {
	upserted: number;
	inserted: number;
	updated: number;
	skippedDuplicate: number;
	errors: number;
	/** First upsert error of the run, so the recorded run says WHY nothing landed. */
	firstError?: string;
}

type ExistingRow = Pick<HistoricalRow, "channel" | "air_date" | "product_name">;

export interface HistoricalPersistenceRepository {
	findExistingRows(input: {
		channels: HistoricalRow["channel"][];
		airDates: string[];
	}): Promise<ExistingRow[]>;
	upsert(rows: HistoricalRow[]): Promise<{ count: number | null }>;
}

export function createHistoricalPersistenceRepository(
	supabase: SupabaseClient,
): HistoricalPersistenceRepository {
	return {
		async findExistingRows(input) {
			const existing: ExistingRow[] = [];
			for (let i = 0; i < input.airDates.length; i += EXISTENCE_LOOKUP_DATE_BATCH) {
				const airDates = input.airDates.slice(i, i + EXISTENCE_LOOKUP_DATE_BATCH);
				let offset = 0;
				while (true) {
					const { data, error } = await supabase
						.from("historical_broadcasts")
						.select("channel,air_date,product_name")
						.in("channel", input.channels)
						.in("air_date", airDates)
						.order("channel")
						.order("air_date")
						.order("product_name")
						.range(offset, offset + EXISTENCE_LOOKUP_PAGE_SIZE - 1);
					if (error) throw new Error(error.message);
					const page = (data ?? []) as ExistingRow[];
					existing.push(...page);
					if (page.length < EXISTENCE_LOOKUP_PAGE_SIZE) break;
					offset += page.length;
				}
			}
			return existing;
		},
		async upsert(rows) {
			const { error, count } = await supabase
				.from("historical_broadcasts")
				.upsert(rows, {
					onConflict: "channel,air_date,product_name",
					ignoreDuplicates: false,
					count: "exact",
				});
			if (error) throw new Error(error.message);
			return { count };
		},
	};
}

function rowKey(row: Pick<HistoricalRow, "channel" | "air_date" | "product_name">): string {
	return JSON.stringify([row.channel, row.air_date, row.product_name]);
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

async function existingKeysForRows(
	repository: HistoricalPersistenceRepository,
	rows: HistoricalRow[],
): Promise<Set<string>> {
	const channels = [...new Set(rows.map((row) => row.channel))];
	const airDates = [...new Set(rows.map((row) => row.air_date))];
	const existingRows = await repository.findExistingRows({ channels, airDates });
	return new Set(existingRows.map(rowKey));
}

/**
 * Upsert rows into historical_broadcasts. The unique constraint
 * (channel, air_date, product_name) deduplicates against existing rows
 * (e.g. from the OA xlsx import). In-batch duplicates are deduped first.
 */
export async function persistRows(
	rows: HistoricalRow[],
	repository: HistoricalPersistenceRepository = createHistoricalPersistenceRepository(getServiceClient()),
): Promise<PersistOutcome> {
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

	let upserted = 0;
	let inserted = 0;
	let updated = 0;
	let errors = 0;
	let firstError: string | undefined;

	for (let i = 0; i < unique.length; i += BATCH) {
		const slice = unique.slice(i, i + BATCH);
		let existingKeys: Set<string>;
		try {
			existingKeys = await existingKeysForRows(repository, slice);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[persistRows] existence lookup error:", message);
			errors += slice.length;
			firstError ??= message;
			continue;
		}
		try {
			const { count } = await repository.upsert(slice);
			const affected = count ?? slice.length;
			upserted += affected;
			const split = splitRowsByExistingKeys(slice, existingKeys);
			inserted += split.inserted;
			updated += split.updated;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[persistRows] upsert error:", message);
			errors += slice.length;
			firstError ??= message;
		}
	}
	return { upserted, inserted, updated, skippedDuplicate, errors, ...(firstError ? { firstError } : {}) };
}

export const __test = { splitRowsByExistingKeys };
