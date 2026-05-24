/**
 * L4 boost — Japanese live-commerce hashtag mention.
 *
 * For each top-N candidate, one Brave query of the form
 *   `"<name>" ("#ライブで紹介" OR "#ライブコマース" OR "ライブで紹介")`.
 * Any hit yields a flat +5. Brave indexes Instagram/Threads/blog mirrors
 * more reliably than X in the JP market; the hashtag itself supplies
 * the live-commerce context regardless of which medium carries it.
 *
 * Spec: docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md §5.5
 */
import { braveSearchItems } from "@/lib/brave";
import type { Candidate } from "./types";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const BOOST = envInt("HASHTAG_MENTION_BOOST", 5);
const CAP = envInt("HASHTAG_MENTION_BOOST_CAP", 30);
const CONCURRENCY = envInt("HASHTAG_MENTION_BOOST_CONCURRENCY", 4);
const PER_CALL_HITS = 5;

const QUERY_SUFFIX =
	`("#ライブで紹介" OR "#ライブコマース" OR "ライブで紹介")`;

/**
 * Mutates `candidates` in place. Re-sorts by tvFitScore after applying.
 * Returns the number of candidates that were boosted.
 */
export async function applyHashtagMentionBoost(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0 || BOOST <= 0) return 0;

	const targets = [...candidates]
		.sort((a, b) => b.tvFitScore - a.tvFitScore)
		.slice(0, CAP);

	let cursor = 0;
	let boosted = 0;

	const worker = async () => {
		while (cursor < targets.length) {
			const idx = cursor++;
			const candidate = targets[idx];
			const query = `"${candidate.name.slice(0, 40)}" ${QUERY_SUFFIX}`;
			try {
				const hits = await braveSearchItems(query, PER_CALL_HITS);
				if (hits.length === 0) continue;
				const next = Math.min(100, candidate.tvFitScore + BOOST);
				if (next === candidate.tvFitScore) continue;
				candidate.tvFitScore = next;
				candidate.tvFitReason =
					`${candidate.tvFitReason} [ライブ紹介ハッシュタグ言及]`.slice(0, 200);
				boosted += 1;
			} catch (err) {
				console.warn(
					`[hashtag-mention-boost] brave query failed for "${candidate.name.slice(0, 40)}":`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(CONCURRENCY, targets.length) },
			() => worker(),
		),
	);

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return boosted;
}

export const __test = {
	envInt,
	BOOST,
	CAP,
	CONCURRENCY,
	QUERY_SUFFIX,
};
