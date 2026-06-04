import { braveSearchItems, type BraveWebResult } from "@/lib/brave";

const SUPERLATIVES = [
	"No.1", "No1", "ナンバーワン", "業界初", "日本一", "世界初", "世界一",
	"最高", "最強", "最安", "最大", "唯一", "100%", "完全", "絶対", "必ず",
];

// number followed by a unit that signals a factual claim
const NUMBER_UNIT = /\d[\d,]*\s*(%|％|円|倍|名|人|個|位|kg|g|ml|cm|mm|時間|分|日|週間|ヶ月|年)/;

/**
 * Heuristic extraction of checkable factual claims. Splits the script into
 * sentences and keeps those containing a number+unit or a superlative/No.1
 * expression. No LLM call. Returns up to maxClaims unique sentences.
 */
export function extractFactClaims(scriptText: string, maxClaims = 5): string[] {
	const sentences = scriptText
		.split(/[\n。！!？?]/)
		.map((s) => s.trim())
		.filter(Boolean);
	const picked: string[] = [];
	const seen = new Set<string>();
	for (const s of sentences) {
		const hasNumber = NUMBER_UNIT.test(s);
		const hasSuper = SUPERLATIVES.some((k) => s.includes(k));
		if (!hasNumber && !hasSuper) continue;
		const key = s.slice(0, 40);
		if (seen.has(key)) continue;
		seen.add(key);
		picked.push(s);
		if (picked.length >= maxClaims) break;
	}
	return picked;
}

export interface FactEvidence {
	claim: string;
	results: BraveWebResult[];
}

/**
 * Run a bounded Brave web search per claim. Best-effort: a failed query yields
 * an empty result set (never throws). Caller bounds count via maxQueries.
 */
export async function searchFactEvidence(
	claims: string[],
	maxQueries: number,
): Promise<FactEvidence[]> {
	const limited = claims.slice(0, Math.max(0, maxQueries));
	const settled = await Promise.allSettled(
		limited.map(async (claim) => ({
			claim,
			results: await braveSearchItems(claim, 5),
		})),
	);
	return settled
		.filter((r): r is PromiseFulfilledResult<FactEvidence> => r.status === "fulfilled")
		.map((r) => r.value);
}

/** http(s) only. */
export function isHttpUrl(u: string): boolean {
	return /^https?:\/\//i.test(u);
}

/**
 * Server-built allowlist of citation URLs the LLM is permitted to cite: the
 * source_url of the injected corpus references (http(s) only) plus every Brave
 * result URL. Used to reject hallucinated / prompt-injected URLs (Codex #2).
 */
export function buildAllowedUrls(corpusUrls: string[], evidence: FactEvidence[]): Set<string> {
	const s = new Set<string>();
	for (const u of corpusUrls) if (isHttpUrl(u)) s.add(u);
	for (const e of evidence) for (const r of e.results) if (isHttpUrl(r.url)) s.add(r.url);
	return s;
}

/** Keep only references whose URL is http(s) AND in the server allowlist. */
export function filterReferences(
	refs: { title: string; url: string }[],
	allowed: Set<string>,
): { title: string; url: string }[] {
	return refs.filter((r) => isHttpUrl(r.url) && allowed.has(r.url));
}

/** Distinct hostnames from fact evidence (for egress audit logging). */
export function evidenceDomains(evidence: FactEvidence[]): string[] {
	const s = new Set<string>();
	for (const e of evidence) {
		for (const r of e.results) {
			try { s.add(new URL(r.url).hostname); } catch { /* skip malformed */ }
		}
	}
	return [...s];
}
