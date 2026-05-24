/**
 * Rakuten ROOM influencer-mention boost for live-commerce discovery.
 *
 * Rakuten ROOM is Rakuten's social/curation platform — users curate
 * "コレ" lists of products they recommend. Strong influencer-driven
 * commerce signal for live-commerce: a product that surfaces on ROOM is
 * one that real curators chose to surface, which correlates with what
 * live-commerce streamers feature.
 *
 * Mechanism: for each top-N candidate, run a single bounded Brave query
 * (`"<name>" site:room.rakuten.co.jp`). If results are returned, add a
 * small additive boost to tvFitScore. Soft signal — never an exclusion.
 *
 * Bounded: capped at ROOM_BOOST_CAP candidates per run (default 30) to
 * stay inside the live-cron Brave budget. Concurrency-limited. Fail-open
 * per call.
 */

import { braveSearchItems } from "@/lib/brave";
import type { Candidate } from "./types";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const ROOM_BOOST = envInt("RAKUTEN_ROOM_BOOST", 5);
const ROOM_BOOST_CAP = envInt("RAKUTEN_ROOM_BOOST_CAP", 30);
const ROOM_BOOST_CONCURRENCY = envInt("RAKUTEN_ROOM_BOOST_CONCURRENCY", 4);

/**
 * Mutates `candidates` in place: bumps tvFitScore by ROOM_BOOST when a
 * Brave query against site:room.rakuten.co.jp returns at least one hit
 * for the candidate's name. Only the top ROOM_BOOST_CAP candidates by
 * tvFitScore are checked. Re-sorts after applying.
 *
 * Returns the number of candidates that were boosted.
 */
export async function applyRakutenRoomBoost(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0 || ROOM_BOOST <= 0) return 0;

	// Operate on the highest-scoring slice — these are the ones likely to
	// reach the final list, and the Brave budget is small.
	const targets = [...candidates]
		.sort((a, b) => b.tvFitScore - a.tvFitScore)
		.slice(0, ROOM_BOOST_CAP);

	let cursor = 0;
	let boosted = 0;
	const worker = async () => {
		while (cursor < targets.length) {
			const idx = cursor++;
			const candidate = targets[idx];
			const query = `"${candidate.name.slice(0, 40)}" site:room.rakuten.co.jp`;
			try {
				const hits = await braveSearchItems(query, 3);
				if (hits.length === 0) continue;
				const next = Math.min(100, candidate.tvFitScore + ROOM_BOOST);
				if (next === candidate.tvFitScore) continue;
				candidate.tvFitScore = next;
				candidate.tvFitReason =
					`${candidate.tvFitReason} [ROOM言及あり]`.slice(0, 200);
				boosted += 1;
			} catch (err) {
				console.warn(
					`[room-boost] brave query failed for "${candidate.name.slice(0, 40)}":`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(ROOM_BOOST_CONCURRENCY, targets.length) },
			() => worker(),
		),
	);

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return boosted;
}

export const __test = {
	envInt,
	ROOM_BOOST,
	ROOM_BOOST_CAP,
	ROOM_BOOST_CONCURRENCY,
};
