import type { ChannelParser, CrawlResult, OAChannelSlug } from "./types";
import { jstToday } from "./types";
import { persistRows, type PersistOutcome } from "./persist";

import { junsanpoParser } from "./parsers/junsanpo";
import { ntvParser } from "./parsers/ntv";
import { tbsParser } from "./parsers/tbs";
import { senoburaParser } from "./parsers/senobura";
import { uranouraParser } from "./parsers/uranoura";
import { dinosParser } from "./parsers/dinos";
import { japanetParser } from "./parsers/japanet";

export const ALL_PARSERS: readonly ChannelParser[] = [
	junsanpoParser,
	ntvParser,
	tbsParser,
	senoburaParser,
	uranouraParser,
	dinosParser,
	japanetParser,
];

export interface CrawlAllResult {
	jstDate: string;
	results: CrawlResult[];
	persist: PersistOutcome;
	totalRows: number;
}

/**
 * Run every channel parser in parallel, then upsert rows in one go.
 * Failures in one channel don't stop the others.
 */
export async function crawlAll(jstDate?: string): Promise<CrawlAllResult> {
	const date = jstDate ?? jstToday();
	const settled = await Promise.allSettled(
		ALL_PARSERS.map(async (p) => {
			const t0 = Date.now();
			try {
				const rows = await p.fetchToday(date);
				return {
					channel: p.slug,
					ok: true,
					rows,
					durationMs: Date.now() - t0,
				} satisfies CrawlResult;
			} catch (e) {
				return {
					channel: p.slug,
					ok: false,
					rows: [],
					error: e instanceof Error ? e.message : String(e),
					durationMs: Date.now() - t0,
				} satisfies CrawlResult;
			}
		}),
	);

	const results: CrawlResult[] = settled.map((s, i) => {
		if (s.status === "fulfilled") return s.value;
		return {
			channel: ALL_PARSERS[i].slug satisfies OAChannelSlug,
			ok: false,
			rows: [],
			error: s.reason instanceof Error ? s.reason.message : String(s.reason),
			durationMs: 0,
		};
	});

	const allRows = results.flatMap((r) => r.rows);
	const persist = await persistRows(allRows);

	return {
		jstDate: date,
		results,
		persist,
		totalRows: allRows.length,
	};
}

export type { CrawlResult, OAChannelSlug, ChannelParser, HistoricalRow } from "./types";
