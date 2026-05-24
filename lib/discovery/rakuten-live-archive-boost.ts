/**
 * L2 boost — Rakuten Shopping Channel archive matching.
 *
 * Rakuten's actual live-commerce platform after the 2021 shutdown of
 * 楽天LIVE is the 楽天市場ショッピングチャンネル at
 * event.rakuten.co.jp/campaign/live-shopping. Archive pages reference
 * the actual products that were broadcast — extracting those item codes
 * gives a high-precision "this product has live-commerce broadcast
 * track record" signal.
 *
 * Method: 3 bulk Brave queries against the archive site → build a Set
 * of `shopCode:itemCode` keys → match against each candidate's
 * `rakutenItemCode`. Falls back to a direct HTTP fetch of the top
 * result page when the Brave excerpts didn't expose product links.
 *
 * Cost: independent of candidate count (~3 Brave calls + at most 1
 * fallback fetch per cron run).
 *
 * Spec: docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md §5.3
 */
import { braveSearchItems } from "@/lib/brave";
import type { Candidate } from "./types";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const BOOST = envInt("RAKUTEN_LIVE_ARCHIVE_BOOST", 5);

const ARCHIVE_QUERIES = [
	"site:event.rakuten.co.jp/campaign/live-shopping",
	"site:event.rakuten.co.jp/campaign/live-shopping ライブ",
	"site:event.rakuten.co.jp/campaign/live-shopping アーカイブ",
];

// Capture group 1 = shopCode, group 2 = itemCode. `g` flag so matchAll
// returns every occurrence in a haystack.
const ITEM_URL_RE = /item\.rakuten\.co\.jp\/([^/]+)\/([^/?#]+)/g;
const FALLBACK_MIN_CODES = 5;
const FALLBACK_FETCH_TIMEOUT_MS = 10_000;

/**
 * Extract `shopCode:itemCode` keys from a free-form string.
 */
function extractItemCodes(haystack: string): string[] {
	const codes: string[] = [];
	for (const m of haystack.matchAll(ITEM_URL_RE)) {
		codes.push(`${m[1]}:${m[2]}`);
	}
	return codes;
}

async function fetchHtmlSafe(url: string): Promise<string> {
	try {
		const res = await fetch(url, {
			headers: { Accept: "text/html" },
			signal: AbortSignal.timeout(FALLBACK_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return "";
		return await res.text();
	} catch {
		return "";
	}
}

/**
 * Mutates `candidates` in place. Returns the number of candidates whose
 * tvFitScore was boosted.
 */
export async function applyRakutenLiveArchiveBoost(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0 || BOOST <= 0) return 0;

	const codeSet = new Set<string>();
	const seedUrls: string[] = [];

	for (const q of ARCHIVE_QUERIES) {
		try {
			const hits = await braveSearchItems(q, 10);
			for (const h of hits) {
				if (h.url) seedUrls.push(h.url);
				for (const code of extractItemCodes(`${h.url} ${h.description}`)) {
					codeSet.add(code);
				}
			}
		} catch (err) {
			console.warn(
				`[archive-boost] brave query failed (${q}):`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// Fallback: Brave excerpts often hide product links. Fetch the top
	// 1-2 archive pages directly and parse for item URLs.
	if (codeSet.size < FALLBACK_MIN_CODES && seedUrls.length > 0) {
		for (const url of seedUrls.slice(0, 2)) {
			const html = await fetchHtmlSafe(url);
			if (!html) continue;
			for (const code of extractItemCodes(html)) {
				codeSet.add(code);
			}
		}
	}

	if (codeSet.size === 0) return 0;

	let boosted = 0;
	for (const c of candidates) {
		if (!c.rakutenItemCode || !codeSet.has(c.rakutenItemCode)) continue;
		const next = Math.min(100, c.tvFitScore + BOOST);
		if (next === c.tvFitScore) continue;
		c.tvFitScore = next;
		c.tvFitReason = `${c.tvFitReason} [楽天LIVE放送実績あり]`.slice(0, 200);
		boosted += 1;
	}
	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return boosted;
}

export const __test = {
	envInt,
	extractItemCodes,
	ARCHIVE_QUERIES,
	BOOST,
	FALLBACK_MIN_CODES,
};
