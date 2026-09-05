/**
 * Which analysed competitor broadcasts are worth looking at for THIS product.
 *
 * A reference contributes structure — how long the demo ran, when the price
 * landed, which objections got answered. It never contributes the competitor's
 * product facts and it never contributes their wording; the copy guard in
 * lib/screenplay/grounding enforces the second half, and this module enforces
 * the first by simply not reading the verbatim table. Everything here is a
 * number, an enum label, or a programme title.
 *
 * Similarity is a weighted mean over the dimensions that can actually be
 * evaluated, not over all four. A slot whose price we never captured is not
 * "0% similar on price" — we do not know, and scoring it as zero would rank
 * every un-enriched slot below every enriched one for a reason that has
 * nothing to do with the product. Same rule as lib/product-finder/ranking.ts.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvidenceType, ObjectionType, PointType } from "@/lib/broadcast-intel/schema";
import type { ProductBrief } from "@/lib/screenplay/types";

export interface ReferenceBroadcast {
	broadcastId: string;
	channel: "qvc" | "shopch";
	airDate: string;
	category: string;
	programTitle: string;
	similarity: number;
	matchedOn: string[];
	analysisId: string;
}

/** One analysed slot, reduced to the comparable half. */
export interface ReferenceCandidate {
	broadcastId: string;
	channel: "qvc" | "shopch";
	airDate: string;
	category: string | null;
	programTitle: string;
	priceJpy: number | null;
	pointTypes: PointType[];
	evidenceTypes: EvidenceType[];
	objectionTypes: ObjectionType[];
}

export const MAX_REFERENCES = 8;
const LOOKBACK_DAYS = Number(process.env.BROADCAST_INTEL_LOOKBACK_DAYS) || 180;
const CANDIDATE_LIMIT = 200;

const WEIGHTS = {
	category: 0.45,
	price_band: 0.2,
	selling_points: 0.2,
	demo_objection: 0.15,
} as const;

type Dimension = keyof typeof WEIGHTS;

/** Two prices are "the same band" at 1.0 and unrelated at 3x apart. Log-ratio
 *  rather than absolute yen: ¥3,000 vs ¥6,000 is the same gap as ¥30,000 vs
 *  ¥60,000 for a buyer, and for a broadcast structure. */
const PRICE_BAND_RATIO = Math.log(3);

/**
 * Japanese keyword → enum label. Deliberately small: this maps a brief onto
 * the analysis vocabulary well enough to rank, and a bigger lexicon would only
 * make the ranking's failures harder to read. Nothing downstream treats a
 * lexicon hit as a fact.
 */
const POINT_KEYWORDS: ReadonlyArray<[PointType, readonly string[]]> = [
	["efficacy", ["効果", "実感", "改善", "パワー", "性能"]],
	["ease_of_use", ["簡単", "手軽", "ワンタッチ", "時短", "使いやすい"]],
	["price_value", ["お得", "価格", "コスパ", "割引", "円"]],
	["safety", ["安全", "無添加", "低刺激", "医療", "認証"]],
	["size_fit", ["サイズ", "軽量", "コンパクト", "収納"]],
	["durability", ["耐久", "長持ち", "丈夫", "保証"]],
	["design", ["デザイン", "カラー", "見た目", "おしゃれ"]],
	["aftercare", ["お手入れ", "洗える", "交換", "サポート"]],
	["scarcity", ["限定", "残り", "数量", "今だけ"]],
];

const EVIDENCE_KEYWORDS: ReadonlyArray<[EvidenceType, readonly string[]]> = [
	["lab_test", ["試験", "実験", "データ", "測定"]],
	["demo", ["実演", "デモ", "実際に", "使ってみ"]],
	["comparison", ["比較", "従来", "他社", "違い"]],
	["testimonial", ["体験", "お客様の声", "口コミ", "愛用"]],
	["expert", ["専門家", "医師", "監修", "プロ"]],
	["certification", ["認証", "受賞", "特許", "認定"]],
];

const OBJECTION_KEYWORDS: ReadonlyArray<[ObjectionType, readonly string[]]> = [
	["price", ["高い", "価格", "予算", "コスト"]],
	["doubt_efficacy", ["本当に", "効果", "疑問", "エビデンス"]],
	["difficulty", ["難しい", "面倒", "使い方", "操作"]],
	["space", ["場所", "置き", "収納", "狭い"]],
	["maintenance", ["お手入れ", "掃除", "洗浄", "メンテ"]],
	["timing", ["今", "季節", "タイミング", "在庫"]],
];

function match<T extends string>(
	text: string,
	lexicon: ReadonlyArray<[T, readonly string[]]>,
): Set<T> {
	const found = new Set<T>();
	for (const [label, keywords] of lexicon) {
		if (keywords.some((k) => text.includes(k))) found.add(label);
	}
	return found;
}

function briefText(brief: ProductBrief): string {
	return [
		brief.name,
		brief.description,
		brief.customization?.keyMessage ?? "",
		...(brief.customization?.mustDemos ?? []),
		...(brief.bonuses ?? []),
	].join("\n");
}

/** What the brief says the product sells on, and what it has to overcome. */
export function briefSignature(brief: ProductBrief): {
	points: Set<PointType>;
	evidence: Set<EvidenceType>;
	objections: Set<ObjectionType>;
	priceJpy: number | null;
	category: string | null;
} {
	const text = briefText(brief);
	const evidence = match(text, EVIDENCE_KEYWORDS);
	// An explicit mustDemos list is an instruction, not a guess: the reference
	// we want is one that actually demonstrated something.
	if ((brief.customization?.mustDemos?.length ?? 0) > 0) evidence.add("demo");
	const price = brief.price?.saleJpy ?? brief.price?.listJpy ?? null;
	return {
		points: match(text, POINT_KEYWORDS),
		evidence,
		objections: match(text, OBJECTION_KEYWORDS),
		priceJpy: typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null,
		category: brief.category?.trim() || null,
	};
}

function coverage<T>(wanted: Set<T>, held: ReadonlySet<T>): number {
	if (wanted.size === 0) return 0;
	let hit = 0;
	for (const item of wanted) if (held.has(item)) hit++;
	return hit / wanted.size;
}

export function scoreReference(
	candidate: ReferenceCandidate,
	signature: ReturnType<typeof briefSignature>,
): { similarity: number; matchedOn: string[] } {
	const scores = new Map<Dimension, number>();

	if (signature.category && candidate.category) {
		scores.set("category", signature.category === candidate.category ? 1 : 0);
	}

	if (signature.priceJpy && candidate.priceJpy && candidate.priceJpy > 0) {
		const ratio = Math.abs(Math.log(signature.priceJpy / candidate.priceJpy));
		scores.set("price_band", Math.max(0, 1 - ratio / PRICE_BAND_RATIO));
	}

	if (signature.points.size > 0) {
		scores.set("selling_points", coverage(signature.points, new Set(candidate.pointTypes)));
	}

	const required = new Set<string>([...signature.evidence, ...signature.objections]);
	if (required.size > 0) {
		const held = new Set<string>([...candidate.evidenceTypes, ...candidate.objectionTypes]);
		scores.set("demo_objection", coverage(required, held));
	}

	// Renormalise over what was evaluable. With nothing evaluable the slot is
	// not similar and not dissimilar — it is unranked, and recency decides.
	let weighted = 0;
	let totalWeight = 0;
	for (const [dimension, score] of scores) {
		weighted += WEIGHTS[dimension] * score;
		totalWeight += WEIGHTS[dimension];
	}

	return {
		similarity: totalWeight === 0 ? 0 : weighted / totalWeight,
		matchedOn: [...scores.entries()].filter(([, s]) => s > 0).map(([d]) => d),
	};
}

function toReference(candidate: ReferenceCandidate, scored: { similarity: number; matchedOn: string[] }): ReferenceBroadcast {
	return {
		broadcastId: candidate.broadcastId,
		channel: candidate.channel,
		airDate: candidate.airDate,
		category: candidate.category ?? "",
		programTitle: candidate.programTitle,
		similarity: Number(scored.similarity.toFixed(4)),
		matchedOn: scored.matchedOn,
		// broadcast_speech_analyses is keyed on broadcast_id, so the analysis
		// and the broadcast share an id. Named separately because Task 7's copy
		// guard loads phrases BY ANALYSIS, and conflating the two identifiers is
		// how that would start reading the wrong slot.
		analysisId: candidate.broadcastId,
	};
}

/** Pure. Ranking is where this feature is right or wrong, so it is exercised
 *  against fixtures rather than against whatever the corpus happens to hold. */
export function rankReferenceBroadcasts(
	candidates: readonly ReferenceCandidate[],
	brief: ProductBrief,
	limit: number = MAX_REFERENCES,
): ReferenceBroadcast[] {
	const signature = briefSignature(brief);
	const ranked = candidates
		.map((candidate) => ({ candidate, scored: scoreReference(candidate, signature) }))
		.sort((a, b) => {
			if (b.scored.similarity !== a.scored.similarity) return b.scored.similarity - a.scored.similarity;
			if (a.candidate.airDate !== b.candidate.airDate) return a.candidate.airDate < b.candidate.airDate ? 1 : -1;
			return a.candidate.broadcastId.localeCompare(b.candidate.broadcastId);
		});

	const selected = ranked.slice(0, limit);

	// QVC's two-minute clips and ShopCh's hour-long programmes are different
	// media. A reference set drawn entirely from one of them teaches the writer
	// one shape and hides the other, so the last slot is given to the better
	// channel's rival when the corpus has both and the ranking picked one.
	const channels = new Set(selected.map((r) => r.candidate.channel));
	if (selected.length >= 2 && channels.size === 1) {
		const missing = ranked.find((r) => !channels.has(r.candidate.channel));
		if (missing) selected[selected.length - 1] = missing;
	}

	return selected.map(({ candidate, scored }) => toReference(candidate, scored));
}

interface AnalysisRow {
	broadcast_id: string;
	channel: "qvc" | "shopch";
	air_date: string;
	category: string | null;
	selling_points: Array<{ pointType: PointType }> | null;
	evidence_cues: Array<{ type: EvidenceType }> | null;
	objection_handlings: Array<{ objectionType: ObjectionType }> | null;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function loadReferenceBroadcasts(
	sb: SupabaseClient,
	brief: ProductBrief,
	limit: number = MAX_REFERENCES,
): Promise<ReferenceBroadcast[]> {
	const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
	const category = brief.category?.trim() || null;

	const columns =
		"broadcast_id, channel, air_date, category, selling_points, evidence_cues, objection_handlings";
	const base = () =>
		sb
			.from("broadcast_speech_analyses")
			.select(columns)
			.gte("air_date", cutoff)
			.order("air_date", { ascending: false })
			.limit(CANDIDATE_LIMIT);

	// Same category first, then a general recent pool. The second query is not
	// a fallback — it is what keeps a free-text or off-whitelist category from
	// producing no references at all, which is the state the old pattern-only
	// path left every such product in.
	const queries = category ? [base().eq("category", category), base()] : [base()];
	const results = await Promise.all(queries);
	const rows: AnalysisRow[] = [];
	const seen = new Set<string>();
	for (const { data, error } of results) {
		if (error) throw new Error(`reference broadcast load failed: ${error.message}`);
		for (const row of (data ?? []) as AnalysisRow[]) {
			if (seen.has(row.broadcast_id)) continue;
			seen.add(row.broadcast_id);
			rows.push(row);
		}
	}
	if (rows.length === 0) return [];

	const ids = rows.map((r) => r.broadcast_id);
	const [titles, prices] = await Promise.all([
		sb.from("broadcasts").select("id, program_title").in("id", ids),
		sb.from("broadcast_products").select("broadcast_id, price_jpy").in("broadcast_id", ids),
	]);
	if (titles.error) throw new Error(`reference title load failed: ${titles.error.message}`);
	// A missing price is a missing dimension, not a failure: scoring skips it.
	if (prices.error) {
		console.warn("[screenplay] reference price load failed (non-fatal):", prices.error.message);
	}

	const titleById = new Map(
		((titles.data ?? []) as Array<{ id: string; program_title: string | null }>).map((r) => [
			r.id,
			r.program_title ?? "",
		]),
	);
	const pricesById = new Map<string, number[]>();
	for (const row of (prices.data ?? []) as Array<{ broadcast_id: string; price_jpy: number | null }>) {
		if (typeof row.price_jpy !== "number" || !Number.isFinite(row.price_jpy)) continue;
		const held = pricesById.get(row.broadcast_id);
		if (held) held.push(row.price_jpy);
		else pricesById.set(row.broadcast_id, [row.price_jpy]);
	}

	const candidates: ReferenceCandidate[] = rows.map((row) => ({
		broadcastId: row.broadcast_id,
		channel: row.channel,
		airDate: row.air_date,
		category: row.category,
		programTitle: titleById.get(row.broadcast_id) ?? "",
		priceJpy: median(pricesById.get(row.broadcast_id) ?? []),
		pointTypes: (row.selling_points ?? []).map((p) => p.pointType).filter(Boolean),
		evidenceTypes: (row.evidence_cues ?? []).map((c) => c.type).filter(Boolean),
		objectionTypes: (row.objection_handlings ?? []).map((o) => o.objectionType).filter(Boolean),
	}));

	return rankReferenceBroadcasts(candidates, brief, limit);
}
