/**
 * Renders a CategoryPattern as the one prompt block the screenplay generator
 * receives about competitors.
 *
 * Only aggregate shares, ordering and frequencies cross this boundary — but
 * that is guaranteed by CategoryPattern's shape, not by this file. The leak
 * test therefore asserts on the aggregate, not on this output.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { CategoryPattern } from "./category-pattern";
import type { ActType, EvidenceType, ObjectionType, PointType } from "./schema";

export const ACT_LABELS_JA: Record<ActType, string> = {
	opening: "導入", problem: "問題提起", product_intro: "商品紹介", demo: "実演",
	evidence: "根拠提示", testimonial: "利用者の声", offer: "オファー",
	cta: "行動喚起", closing: "締め",
};

export const POINT_LABELS_JA: Record<PointType, string> = {
	efficacy: "効果", ease_of_use: "手軽さ", price_value: "価格納得感", safety: "安全性",
	size_fit: "サイズ・適合", durability: "耐久性", design: "デザイン",
	aftercare: "アフターケア", scarcity: "希少性",
};

export const EVIDENCE_LABELS_JA: Record<EvidenceType, string> = {
	lab_test: "試験成績", demo: "実演", comparison: "比較",
	testimonial: "利用者の声", expert: "専門家", certification: "認証",
};

export const OBJECTION_LABELS_JA: Record<ObjectionType, string> = {
	price: "価格への抵抗", doubt_efficacy: "効果への疑い", difficulty: "使いこなせるか",
	space: "置き場所", maintenance: "手入れの手間", timing: "今買う理由",
};

const CHANNEL_LABELS: Record<string, string> = { qvc: "QVC", shopch: "ShopCh" };

/** `category` comes from the product brief, which an operator edits freely —
 *  it is the only user-controlled string in this block. Collapse anything that
 *  could add a line or a heading, and cap the length. */
export function sanitiseCategory(raw: string): string {
	return raw
		.replace(/[\u0000-\u001F\u007F]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40);
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;

function mmss(totalSec: number): string {
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}分${String(s).padStart(2, "0")}秒`;
}

export function formatCategoryPatternBlock(pattern: CategoryPattern): string {
	const category = sanitiseCategory(pattern.category);
	const channels = pattern.channels.map((c) => CHANNEL_LABELS[c] ?? c).join("・");
	const runtimeMin = Math.round(pattern.runtimeMedianSec / 60);

	// presenceRate travels with every act: medianShare values are independent
	// medians that do not sum to 1, so this is described as "often seen",
	// never as a definitive structure.
	// Acts recur — product_intro three times, demo four — so each figure is the
	// act's TOTAL share of the runtime and the number of separate passes it is
	// spread over. Rendering one instance's length here instead would read as a
	// breakdown summing to 100% while summing to about 42%, and a writer would
	// give an act a fraction of the time the programmes actually spend on it.
	const acts = pattern.actSequence
		.map((a) => {
			const passes = Math.round(a.medianOccurrences);
			const repeat = passes > 1 ? `${passes}回に分けて` : "";
			return `${ACT_LABELS_JA[a.actType]} 計${pct(a.medianShare)}（${repeat}出現 ${pct(a.presenceRate)}）`;
		})
		.join(" → ");

	const points = pattern.sellingPointOrder
		.map((p) => `${POINT_LABELS_JA[p.pointType]}（${pct(p.presenceRate)}）`)
		.join(" → ");

	const evidence = pattern.evidenceMix
		.map((e) => `${EVIDENCE_LABELS_JA[e.type]} ${pct(e.presenceRate)}`)
		.join(" / ");

	const objections = pattern.objectionMix
		.map((o) => `${OBJECTION_LABELS_JA[o.type]} ${pct(o.presenceRate)}`)
		.join(" / ");

	const offer =
		pattern.offerTiming.firstPriceShare === null
			? `価格提示のタイミングは集計できていない。CTA 中央値 ${pattern.offerTiming.ctaCountMedian}回`
			: `価格初出は尺の ${pct(pattern.offerTiming.firstPriceShare)}（中央値 ${mmss(pattern.offerTiming.firstPriceMedianSec!)}地点）、CTA 中央値 ${pattern.offerTiming.ctaCountMedian}回`;

	return [
		`## 競合放送の構成パターン（同カテゴリ ${pattern.sampleSize}件の集計・構成の参考のみ）`,
		`- 集計対象: ${category} / ${channels} / ${pattern.sampleSize}番組 / 尺中央値 ${runtimeMin}分`,
		`- よく見られる構成: ${acts}`,
		`- 販売ポイント提示順: ${points}`,
		`- 根拠提示の型: ${evidence}`,
		`- 想定される視聴者の懸念: ${objections}`,
		`- オファー進行: ${offer}`,
		"- 用途制限: 構成設計にのみ使用する。競合商品の名称・数値・性能・特典・固有の実演内容は",
		"  含まれておらず、推測して補完してはならない。上記の比率は本商品の尺に換算して用いる。上記の並び順は",
		"  サンプル内各要素の開始位置の中央値であり、必須の順序ではない。台本の構成は本商品の必要に応じて決めること。",
	].join("\n");
}
