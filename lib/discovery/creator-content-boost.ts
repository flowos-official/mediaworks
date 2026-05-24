/**
 * L3 boost — YouTube + TikTok creator-content mention.
 *
 * For each top-N candidate, one Brave query against site:youtube.com
 * OR site:tiktok.com. A noise filter requires the result's title to
 * contain at least 2 tokens from the candidate's product name to count.
 * Tiered boost: hits >= 1 → +3, hits >= 3 → +5.
 *
 * Spec: docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md §5.4
 */
import { braveSearchItems } from "@/lib/brave";
import type { Candidate } from "./types";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const CAP = envInt("CREATOR_CONTENT_BOOST_CAP", 30);
const TIER1 = envInt("CREATOR_CONTENT_BOOST_TIER1", 3);
const TIER2 = envInt("CREATOR_CONTENT_BOOST_TIER2", 5);
const CONCURRENCY = envInt("CREATOR_CONTENT_BOOST_CONCURRENCY", 4);
const TIER2_THRESHOLD = 3;
const PER_CALL_HITS = 10;
const MIN_NAME_TOKEN_MATCHES = 2;

/**
 * Split a product name into tokens >= 2 chars. NFKC-normalize first so
 * a full-width katakana name and its half-width form tokenize the same
 * way.
 */
export function tokenizeName(name: string): string[] {
	if (!name) return [];
	return name
		.normalize("NFKC")
		.split(/[\s・\/／,、|\-【】\[\]＜＞]+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 2)
		.slice(0, 6);
}

/**
 * Mutates `candidates` in place. Re-sorts by tvFitScore after applying.
 * Returns the number of candidates that were boosted.
 */
export async function applyCreatorContentBoost(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0 || TIER1 <= 0) return 0;

	const targets = [...candidates]
		.sort((a, b) => b.tvFitScore - a.tvFitScore)
		.slice(0, CAP);

	let cursor = 0;
	let boosted = 0;

	const worker = async () => {
		while (cursor < targets.length) {
			const idx = cursor++;
			const candidate = targets[idx];
			const query =
				`"${candidate.name.slice(0, 40)}" (site:youtube.com OR site:tiktok.com)`;
			try {
				const hits = await braveSearchItems(query, PER_CALL_HITS);
				const tokens = tokenizeName(candidate.name);
				const matching = hits.filter((h) => {
					const title = (h.title ?? "").normalize("NFKC");
					let matches = 0;
					for (const t of tokens) {
						if (title.includes(t)) matches += 1;
						if (matches >= MIN_NAME_TOKEN_MATCHES) return true;
					}
					return false;
				});
				if (matching.length === 0) continue;
				const boost = matching.length >= TIER2_THRESHOLD ? TIER2 : TIER1;
				const next = Math.min(100, candidate.tvFitScore + boost);
				if (next === candidate.tvFitScore) continue;
				candidate.tvFitScore = next;
				const shown = Math.min(matching.length, 5);
				candidate.tvFitReason =
					`${candidate.tvFitReason} [YouTube/TikTok言及 ${shown}件]`.slice(
						0,
						200,
					);
				boosted += 1;
			} catch (err) {
				console.warn(
					`[creator-content-boost] brave query failed for "${candidate.name.slice(0, 40)}":`,
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
	tokenizeName,
	CAP,
	TIER1,
	TIER2,
	TIER2_THRESHOLD,
	CONCURRENCY,
	MIN_NAME_TOKEN_MATCHES,
};
