import { upsertBroadcasts, type BroadcastIdMap } from "./persist";
import { scrapeQVCForDate } from "./qvc";
import { scrapeShopChannelForDate } from "./shopch";
import type { PersistResult, ScrapeResult } from "./types";

export interface ScrapeAllSummary {
	results: ScrapeResult[];
	totalInserted: number;
	totalUpdated: number;
	totalErrors: number;
	/** channel|air_date|start_time → broadcast row id, aggregated from both channels. */
	broadcastIds: BroadcastIdMap;
}

export async function scrapeAllForDate(date: Date): Promise<ScrapeAllSummary> {
	const [shopchResult, qvcResult] = await Promise.all([
		scrapeShopChannelForDate(date).catch(
			(e): ScrapeResult => ({
				channel: "shopch",
				date: date.toISOString().slice(0, 10),
				slots: [],
				ok: false,
				error: e instanceof Error ? e.message : String(e),
				health: { expectedNonZero: true, actualCount: 0, fieldCoverage: { presenter: 0, description: 0, thumbnail_url: 0 } },
			}),
		),
		scrapeQVCForDate(date).catch(
			(e): ScrapeResult => ({
				channel: "qvc",
				date: date.toISOString().slice(0, 10),
				slots: [],
				ok: false,
				error: e instanceof Error ? e.message : String(e),
				health: { expectedNonZero: true, actualCount: 0, fieldCoverage: { presenter: 0, description: 0, thumbnail_url: 0 } },
			}),
		),
	]);

	const persistPromises: Promise<PersistResult & { broadcastIds: BroadcastIdMap }>[] = [];
	for (const r of [shopchResult, qvcResult]) {
		if (r.ok && r.slots.length > 0) {
			persistPromises.push(upsertBroadcasts(r.slots));
		}
		// 마크업 변경 의심 경고
		if (r.health.expectedNonZero && r.health.actualCount === 0 && r.ok) {
			console.warn(
				`WARN: ${r.channel} returned 0 slots for ${r.date} — markup change suspected?`,
			);
		}
	}
	const persisted = await Promise.all(persistPromises);

	const totalInserted = persisted.reduce((sum, p) => sum + p.inserted, 0);
	const totalUpdated = persisted.reduce((sum, p) => sum + p.updated, 0);
	const totalErrors = persisted.reduce((sum, p) => sum + p.errors.length, 0);

	// Merge broadcastIds from all channels into a single map.
	const broadcastIds: BroadcastIdMap = new Map();
	for (const p of persisted) {
		for (const [k, v] of p.broadcastIds) {
			broadcastIds.set(k, v);
		}
	}

	return {
		results: [shopchResult, qvcResult],
		totalInserted,
		totalUpdated,
		totalErrors,
		broadcastIds,
	};
}

// Public re-exports
export type { BroadcastChannel, ScrapedSlot, ScrapeResult } from "./types";
