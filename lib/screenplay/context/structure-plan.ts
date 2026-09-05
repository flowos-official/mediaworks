/**
 * Decide the running order before writing a word of it.
 *
 * The generator has always produced structure and prose in one pass, which
 * means the structure exists only as headings inside the finished script.
 * Nothing can check that the demo the operator asked for actually got a slot,
 * or that the offer lands where the corpus says it lands, or that a section
 * making a factual claim had a fact to make it from. A plan makes all three
 * checkable, and it gets persisted, so a version can be read back as the
 * broadcast that was planned.
 *
 * Three rules:
 *
 *   `basis` is ours, not the model's. It comes from the pattern status. A
 *   model asked to report what informed it will report whatever the prompt
 *   implied.
 *
 *   Runtime shares are normalised only if they were nearly right to begin
 *   with. A plan whose sections sum to 0.4 is not a plan that needs scaling —
 *   it is a plan the model did not finish, and scaling it up would invent a
 *   40-minute demo out of a 4-minute one.
 *
 *   A section may only make factual statements from the fact keys it lists,
 *   and a key that is not in the pack is dropped. Dropping is the safe
 *   direction: the section claims less grounding than it asked for, never
 *   more.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import { z } from "zod";
import { formatCategoryPatternBlock } from "@/lib/broadcast-intel/format-prompt";
import type { ProductBrief } from "@/lib/screenplay/types";
import type { PatternLoadResult } from "./pattern-result";
import type { ReferenceBroadcast } from "./reference-broadcasts";
import type {
	DemoPlanItem,
	ProductFactPack,
	ScreenplayOutlineSection,
	ScreenplayStructurePlan,
} from "./types";

export type { DemoPlanItem, ScreenplayOutlineSection, ScreenplayStructurePlan };

export const DEFAULT_RUNTIME_MINUTES = 25;

/** A plan whose shares fall outside this band was not "slightly off" — it was
 *  not finished. Normalising it would fabricate structure. */
const SHARE_MIN_SUM = 0.85;
const SHARE_MAX_SUM = 1.15;

export class StructurePlanError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "StructurePlanError";
		this.code = code;
	}
}

const SectionSchema = z.object({
	id: z.string().trim().min(1).max(40),
	title: z.string().trim().min(1).max(80),
	purpose: z.string().trim().min(1).max(300),
	runtimeShare: z.number().gt(0).lte(1),
	keyMessages: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
	factKeys: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
	patternBasis: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
});

const DemoSchema = z.object({
	id: z.string().trim().min(1).max(40),
	sectionId: z.string().trim().min(1).max(40),
	title: z.string().trim().min(1).max(80),
	hostAction: z.string().trim().min(1).max(300),
	cameraCue: z.string().trim().min(1).max(200),
	requiredFactKeys: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
	safetyNote: z.string().trim().max(200).nullable().default(null),
});

const PlanSchema = z.object({
	runtimeMinutes: z.number().gt(0).lte(180),
	sections: z.array(SectionSchema).min(3).max(12),
	demos: z.array(DemoSchema).max(10).default([]),
});

export interface StructurePlanInput {
	factPack: ProductFactPack;
	patternResult: PatternLoadResult;
	references: readonly ReferenceBroadcast[];
	brief: ProductBrief;
}

/** Generated JSON, as text. The caller owns the model and its attribution. */
export type StructurePlanGenerator = (prompt: string) => Promise<string>;

function runtimeMinutesOf(brief: ProductBrief): number {
	const requested = brief.customization?.runtimeMinutes;
	return typeof requested === "number" && Number.isFinite(requested) && requested > 0
		? requested
		: DEFAULT_RUNTIME_MINUTES;
}

function mustDemos(brief: ProductBrief): string[] {
	return (brief.customization?.mustDemos ?? []).map((d) => d.trim()).filter(Boolean);
}

/**
 * The deterministic skeleton. Used as the baseline shape in the prompt when no
 * competitor pattern applies, and returned whole by a caller with no model
 * available — a generic rundown that says it is generic beats no rundown.
 */
export function genericStructurePlan(input: StructurePlanInput): ScreenplayStructurePlan {
	const runtimeMinutes = runtimeMinutesOf(input.brief);
	const factKeys = input.factPack.facts.filter((f) => f.usage === "direct").map((f) => f.key);
	const has = (key: string) => factKeys.includes(key);

	const sections: ScreenplayOutlineSection[] = [
		{ id: "opening", title: "導入", purpose: "視聴者の手を止め、今日の商品を提示する", runtimeShare: 0.08, keyMessages: [], factKeys: has("name") ? ["name"] : [], patternBasis: [] },
		{ id: "problem", title: "問題提起", purpose: "商品が解決する日常の困りごとを具体化する", runtimeShare: 0.15, keyMessages: [], factKeys: [], patternBasis: [] },
		{ id: "product_intro", title: "商品紹介", purpose: "商品の要点を事実に基づいて説明する", runtimeShare: 0.17, keyMessages: [], factKeys: factKeys.filter((k) => k === "name" || k === "description" || k === "category"), patternBasis: [] },
		{ id: "demo", title: "実演", purpose: "使い方と効果を実際に見せる", runtimeShare: 0.3, keyMessages: [], factKeys: [], patternBasis: [] },
		{ id: "objection", title: "疑問への回答", purpose: "購入をためらう理由に先回りして答える", runtimeShare: 0.12, keyMessages: [], factKeys: factKeys.filter((k) => k === "guarantee"), patternBasis: [] },
		{ id: "offer", title: "オファー", purpose: "価格・特典・申し込み方法を明確に伝える", runtimeShare: 0.12, keyMessages: [], factKeys: factKeys.filter((k) => k.startsWith("price") || k === "bonuses"), patternBasis: [] },
		{ id: "closing", title: "締め", purpose: "要点を繰り返し、行動を促す", runtimeShare: 0.06, keyMessages: [], factKeys: [], patternBasis: [] },
	];

	const required = mustDemos(input.brief);
	const demos: DemoPlanItem[] = (required.length > 0 ? required : ["商品の基本的な使い方"]).map((title, i) => ({
		id: `demo-${i + 1}`,
		sectionId: "demo",
		title,
		hostAction: "手元が見える位置で実際に操作し、変化を口頭で説明する",
		cameraCue: "手元アップ → 全体引き",
		requiredFactKeys: [],
		safetyNote: null,
	}));

	return { basis: "generic", runtimeMinutes, sections, demos };
}

function stripFence(raw: string): string {
	const trimmed = raw.trim();
	const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	const body = fence ? fence[1].trim() : trimmed;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end <= start) {
		throw new StructurePlanError("structure_plan_unparseable", "no JSON object in the structure plan response");
	}
	return body.slice(start, end + 1);
}

/** Scale shares to sum to exactly 1, but only from a sum that was already
 *  close. The last section absorbs the rounding so the total is exact. */
function normaliseShares(sections: ScreenplayOutlineSection[]): ScreenplayOutlineSection[] {
	const sum = sections.reduce((acc, s) => acc + s.runtimeShare, 0);
	if (sum < SHARE_MIN_SUM || sum > SHARE_MAX_SUM) {
		throw new StructurePlanError(
			"structure_plan_incoherent_runtime",
			`section runtime shares sum to ${sum.toFixed(3)}, outside ${SHARE_MIN_SUM}–${SHARE_MAX_SUM}`,
		);
	}
	const scaled = sections.map((s) => ({ ...s, runtimeShare: Number((s.runtimeShare / sum).toFixed(4)) }));
	const drift = Number((1 - scaled.reduce((acc, s) => acc + s.runtimeShare, 0)).toFixed(4));
	const last = scaled[scaled.length - 1];
	last.runtimeShare = Number((last.runtimeShare + drift).toFixed(4));
	return scaled;
}

/** Pure. Everything that can make a plan wrong happens here. */
export function validateStructurePlan(
	raw: unknown,
	input: StructurePlanInput,
): ScreenplayStructurePlan {
	const parsed = PlanSchema.safeParse(raw);
	if (!parsed.success) {
		throw new StructurePlanError(
			"structure_plan_invalid",
			`structure plan failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300)}`,
		);
	}
	const plan = parsed.data;

	const sectionIds = plan.sections.map((s) => s.id);
	if (new Set(sectionIds).size !== sectionIds.length) {
		throw new StructurePlanError("structure_plan_duplicate_section", "two sections share an id");
	}
	const demoIds = plan.demos.map((d) => d.id);
	if (new Set(demoIds).size !== demoIds.length) {
		throw new StructurePlanError("structure_plan_duplicate_demo", "two demos share an id");
	}
	const known = new Set(sectionIds);
	for (const demo of plan.demos) {
		if (!known.has(demo.sectionId)) {
			throw new StructurePlanError(
				"structure_plan_orphan_demo",
				`demo ${demo.id} points at section ${demo.sectionId}, which does not exist`,
			);
		}
	}

	// A key outside the pack is not grounding. Dropped rather than rejected:
	// the section then claims less than it asked for, which is the safe
	// direction, and the drop is logged so a systematic one is visible.
	const packKeys = new Set(input.factPack.facts.filter((f) => f.usage !== "planning_only").map((f) => f.key));
	const dropped = new Set<string>();
	const keep = (keys: string[]): string[] =>
		keys.filter((k) => {
			if (packKeys.has(k)) return true;
			dropped.add(k);
			return false;
		});

	const sections = normaliseShares(
		plan.sections.map((s) => ({ ...s, factKeys: keep(s.factKeys) })),
	);
	const demos: DemoPlanItem[] = plan.demos.map((d) => ({ ...d, requiredFactKeys: keep(d.requiredFactKeys) }));

	if (dropped.size > 0) {
		console.warn(
			`[screenplay] structure plan referenced fact keys not in the pack: ${[...dropped].join(", ")}`,
		);
	}

	// Every demo the operator asked for gets exactly one slot. Matching is by
	// title so a model that reworded one does not cause a duplicate; a demo it
	// dropped entirely is appended rather than silently lost.
	const required = mustDemos(input.brief);
	const demoSectionId = sections.find((s) => /demo|実演/.test(s.id) || /実演/.test(s.title))?.id ?? sections[0].id;
	const finalDemos: DemoPlanItem[] = [];
	const usedTitles = new Set<string>();
	for (const demo of demos) {
		const key = demo.title.trim();
		if (usedTitles.has(key)) continue;
		usedTitles.add(key);
		finalDemos.push(demo);
	}
	for (const title of required) {
		if ([...usedTitles].some((t) => t.includes(title) || title.includes(t))) continue;
		usedTitles.add(title);
		finalDemos.push({
			id: `required-${finalDemos.length + 1}`,
			sectionId: demoSectionId,
			title,
			hostAction: "手元が見える位置で実際に操作し、変化を口頭で説明する",
			cameraCue: "手元アップ → 全体引き",
			requiredFactKeys: [],
			safetyNote: null,
		});
	}

	return {
		basis: input.patternResult.status === "applied" ? "competitor_pattern" : "generic",
		runtimeMinutes: plan.runtimeMinutes,
		sections,
		demos: finalDemos,
	};
}

export function buildStructurePlanPrompt(input: StructurePlanInput): string {
	const runtimeMinutes = runtimeMinutesOf(input.brief);
	const facts = input.factPack.facts.map(
		(f) => `- ${f.key} (${f.label} / ${f.usage}): ${JSON.stringify(f.value)}${f.unit ? ` ${f.unit}` : ""}`,
	);
	const skeleton = genericStructurePlan(input)
		.sections.map((s) => `- ${s.id} (${s.title}): ${Math.round(s.runtimeShare * 100)}%`)
		.join("\n");

	const parts = [
		"# タスク：テレビショッピング放送の構成表と実演計画を JSON で作成する",
		"あなたは放送作家です。台本の本文はまだ書きません。放送の進行表だけを作ります。",
		"",
		"## 出力形式（JSON のみ。前置き・後書き・コードフェンス禁止）",
		JSON.stringify(
			{
				runtimeMinutes,
				sections: [
					{
						id: "opening",
						title: "導入",
						purpose: "この区分の目的",
						runtimeShare: 0.08,
						keyMessages: ["この区分で必ず伝えること"],
						factKeys: ["事実欄のキーのみ"],
						patternBasis: ["競合構成のどの観察に基づくか"],
					},
				],
				demos: [
					{
						id: "demo-1",
						sectionId: "demo",
						title: "実演名",
						hostAction: "出演者の動作",
						cameraCue: "カメラ指示",
						requiredFactKeys: ["事実欄のキーのみ"],
						safetyNote: null,
					},
				],
			},
			null,
			1,
		),
		"",
		"## 絶対条件",
		`- 放送尺は ${runtimeMinutes} 分。runtimeShare の合計は 1.0 になること。`,
		"- factKeys / requiredFactKeys には下の「使用可能な事実」に存在するキーのみを書く。存在しないキーは書かない。",
		"- keyMessages に数値・実績・順位・満足度を書いてよいのは、その数値が事実欄にある場合だけ。",
		"- 参照放送は構成の参考。競合商品の名称・数値・表現を持ち込まない。",
		"",
		"## 使用可能な事実",
		facts.length > 0 ? facts.join("\n") : "- （事実データなし）",
		"",
		"## 不足している情報（これらに触れる構成を作らない）",
		input.factPack.missing.length > 0 ? input.factPack.missing.map((m) => `- ${m}`).join("\n") : "- （なし）",
		"",
		"## 禁止事項",
		input.factPack.forbiddenClaims.map((c) => `- ${c}`).join("\n"),
	];

	if (input.patternResult.status === "applied" && input.patternResult.pattern) {
		parts.push("", formatCategoryPatternBlock(input.patternResult.pattern));
	} else {
		parts.push(
			"",
			`## 競合構成データなし（${input.patternResult.status}: ${input.patternResult.detail}）`,
			"下の一般的な配分を出発点にし、商品特性に応じて調整する。",
			skeleton,
		);
	}

	if (input.references.length > 0) {
		parts.push(
			"",
			"## 参照放送（構成の参考。商品事実として使用しない）",
			...input.references.map(
				(r) =>
					`- ${r.channel} / ${r.airDate} / ${r.category || "カテゴリ不明"} / 類似度 ${r.similarity} / 一致: ${r.matchedOn.join(",") || "なし"}`,
			),
		);
	}

	const custom = input.brief.customization;
	if (custom?.mustDemos?.length) {
		parts.push("", "## 必須の実演（すべて demos に含めること）", ...custom.mustDemos.map((d) => `- ${d}`));
	}
	if (custom?.keyMessage) parts.push("", `## キーメッセージ\n- ${custom.keyMessage}`);

	return parts.join("\n");
}

export async function buildStructurePlan(
	input: StructurePlanInput,
	generateJson: StructurePlanGenerator,
): Promise<ScreenplayStructurePlan> {
	const raw = await generateJson(buildStructurePlanPrompt(input));
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFence(raw));
	} catch (error) {
		if (error instanceof StructurePlanError) throw error;
		throw new StructurePlanError(
			"structure_plan_unparseable",
			`structure plan response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return validateStructurePlan(parsed, input);
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** The block the screenplay prompt receives. Order and share are the contract;
 *  the writer fills them, it does not renegotiate them. */
export function formatStructurePlanBlock(plan: ScreenplayStructurePlan): string {
	const basis =
		plan.basis === "competitor_pattern"
			? "同カテゴリの競合放送の集計に基づく構成"
			: "一般的なテレビショッピング構成（競合データなし）";
	const lines = [
		"## 確定済み放送構成",
		`- 根拠: ${basis}`,
		`- 放送尺: ${plan.runtimeMinutes}分`,
		"- 下記の区分・順序・尺配分は確定済み。順序を変えず、配分を大きく外さないこと。",
		"- 各区分の事実記述は、その区分に記載された事実キーの範囲内でのみ行う。",
		"",
		"| 順 | 区分 | 尺 | 目的 | 使用可能な事実 |",
		"| --- | --- | --- | --- | --- |",
		...plan.sections.map(
			(s, i) =>
				`| ${i + 1} | ${s.title} | ${pct(s.runtimeShare)} | ${s.purpose} | ${s.factKeys.join(", ") || "—"} |`,
		),
	];

	for (const section of plan.sections) {
		if (section.keyMessages.length === 0) continue;
		lines.push("", `### ${section.title} で必ず伝えること`, ...section.keyMessages.map((m) => `- ${m}`));
	}

	if (plan.demos.length > 0) {
		lines.push("", "### 実演計画（すべて台本に含めること）");
		for (const demo of plan.demos) {
			const section = plan.sections.find((s) => s.id === demo.sectionId);
			lines.push(
				`- ${demo.title}（${section?.title ?? demo.sectionId}）: ${demo.hostAction} / カメラ: ${demo.cameraCue}${demo.safetyNote ? ` / 注意: ${demo.safetyNote}` : ""}`,
			);
		}
	}

	return lines.join("\n");
}
