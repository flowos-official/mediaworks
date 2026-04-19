/**
 * Broadcast tagging — for each candidate, query Brave for competitor
 * TV-shopping broadcast evidence, then batch-classify via Gemini.
 * Ref: spec §4.2 単階 7.
 *
 * Output tags: broadcast_confirmed | broadcast_likely | unknown.
 * Never used as exclusion. Applied as a modest additive ranking boost via
 * applyBroadcastBoost (below) before persistence.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { braveSearchItems, type BraveWebResult } from "@/lib/brave";
import type { BroadcastTag, Candidate } from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";

const COMPETITORS = "(QVCジャパン OR ジャパネット OR ショップチャンネル OR テレ東ポシュレ)";

// Additive boosts applied post-curation, pre-save. Kept small so they nudge
// ranking without overriding the Gemini-computed breakdown.
const BROADCAST_BOOST: Record<BroadcastTag, number> = {
	broadcast_confirmed: 8,
	broadcast_likely: 3,
	unknown: 0,
};

export interface BroadcastResult {
	productUrl: string;
	tag: BroadcastTag;
	sources: Array<{ title: string; url: string }>;
}

/**
 * Apply the broadcast-evidence boost to each candidate's tvFitScore in place,
 * capping at 100. Returns the same list (sorted DESC by new score).
 *
 * Only confirmed/likely competitor broadcasts move the score; unknown is a
 * no-op so candidates without evidence are neither rewarded nor penalized.
 */
export function applyBroadcastBoost(
	candidates: Candidate[],
	tagByUrl: Map<string, BroadcastTag>,
): Candidate[] {
	for (const c of candidates) {
		const tag = tagByUrl.get(c.productUrl) ?? "unknown";
		const boost = BROADCAST_BOOST[tag];
		if (boost === 0) continue;
		const next = Math.min(100, c.tvFitScore + boost);
		if (next === c.tvFitScore) continue;
		c.tvFitScore = next;
		const note = tag === "broadcast_confirmed" ? "放送実績あり" : "放送兆候あり";
		c.tvFitReason = `${c.tvFitReason} [${note}]`.slice(0, 200);
	}
	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return candidates;
}

/**
 * Query Brave for broadcast evidence per candidate (parallel).
 * Truncates product name to 40 chars for query length safety.
 */
async function fetchEvidenceForCandidates(
	candidates: Candidate[],
): Promise<Map<string, BraveWebResult[]>> {
	const results = new Map<string, BraveWebResult[]>();

	const batch = await Promise.allSettled(
		candidates.map(async (c) => {
			const query = `"${c.name.slice(0, 40)}" ${COMPETITORS} 放送`;
			const items = await braveSearchItems(query, 5);
			return { url: c.productUrl, items };
		}),
	);

	for (const r of batch) {
		if (r.status !== "fulfilled") continue;
		results.set(r.value.url, r.value.items);
	}
	return results;
}

/**
 * Batch-classify candidates using Gemini from their Brave evidence.
 * One Gemini call for all candidates to reduce latency.
 * On failure, tags all 'unknown' (fail-open).
 */
export async function tagBroadcastEvidence(
	candidates: Candidate[],
): Promise<BroadcastResult[]> {
	if (candidates.length === 0) return [];

	const evidenceMap = await fetchEvidenceForCandidates(candidates);

	const evidenceBlocks = candidates
		.map((c, i) => {
			const items = evidenceMap.get(c.productUrl) ?? [];
			const lines = items
				.slice(0, 3)
				.map(
					(it, j) =>
						`    (${j + 1}) ${it.title} | ${it.url}\n        ${it.description.slice(0, 140)}`,
				)
				.join("\n");
			return `[${i}] ${c.name.slice(0, 80)}\n${lines || "    (no search results)"}`;
		})
		.join("\n\n");

	const prompt = `日本のTV通販・ライブコマース企業の放送実績を判定します。
以下の各商品について、競合TV通販チャンネル（QVCジャパン、ジャパネット、ショップチャンネル、テレ東ポシュレなど）での放送歴があるか、検索結果から判定してください。

【判定基準】
- broadcast_confirmed: 放送された証拠が明確（チャンネル名+商品名+放送/販売キーワード）
- broadcast_likely: 間接的な兆候あり（通販実績のある類似商品、店舗ページで扱いなど）
- unknown: 検索結果から判断できない

【判定対象】
${evidenceBlocks}

【出力 — JSONのみ、前置き/後書きなし】
{
  "results": [
    {"index": 0, "tag": "unknown"},
    {"index": 1, "tag": "broadcast_confirmed"}
  ]
}`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) throw new Error("no JSON in broadcast tag response");
		const parsed = JSON.parse(match[0]) as {
			results?: Array<{ index: number; tag: BroadcastTag }>;
		};
		const tagMap = new Map<number, BroadcastTag>();
		for (const r of parsed.results ?? []) {
			tagMap.set(r.index, r.tag);
		}
		return candidates.map((c, i) => ({
			productUrl: c.productUrl,
			tag: tagMap.get(i) ?? "unknown",
			sources: (evidenceMap.get(c.productUrl) ?? []).slice(0, 3).map((e) => ({
				title: e.title,
				url: e.url,
			})),
		}));
	} catch (err) {
		console.warn(
			"[broadcast] Gemini classification failed, defaulting to unknown:",
			err instanceof Error ? err.message : String(err),
		);
		return candidates.map((c) => ({
			productUrl: c.productUrl,
			tag: "unknown" as BroadcastTag,
			sources: (evidenceMap.get(c.productUrl) ?? []).slice(0, 3).map((e) => ({
				title: e.title,
				url: e.url,
			})),
		}));
	}
}
