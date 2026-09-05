// lib/screenplay/prompt.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { GenerateInput, ProductBrief } from "./types";

const STYLE_DIR = path.join(process.cwd(), "lib/screenplay/style");
const BASE_STYLE_BIBLE_PATH = path.join(process.cwd(), "lib/screenplay/style-bible.json");

const _styleCache = new Map<string, string>();

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function japanesePhrases(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.replace(/\s*[（(][A-Za-z][^）)]*[）)]/g, "").trim())
		.filter((item) => /[ぁ-んァ-ン一-龯]/u.test(item));
}

/**
 * The raw style bible contains English analysis and facts from one observed
 * cleaner script. Passing that verbatim made unrelated products inherit its
 * claims and demonstrations. Only retain Japanese rhythm examples and state
 * the small evidence base explicitly.
 */
export function buildSafeStyleReference(content: string): string {
	try {
		const root = asRecord(JSON.parse(content));
		const profile = asRecord(root.show_profile);
		const observedProducts = Array.isArray(profile.product_lineup_observed)
			? profile.product_lineup_observed.length
			: 0;
		const phrases: string[] = [];

		// Only neutral transition vocabulary is safe to transfer from a single
		// observed product. Full example lines encode that product's category,
		// claims, demonstrations and offer, so they are intentionally excluded.
		const style = asRecord(root.writing_style_dna);
		phrases.push(...japanesePhrases(style.filler_and_transition_phrases_jp));

		const unique = [...new Set(phrases)].slice(0, 24);
		return [
			"## 放送文体リファレンス（限定的な参考情報）",
			`- 観測資料: ${observedProducts}商品。現時点の文体パターンは仮説であり、全カテゴリの正解ではない。`,
			"- 転用してよいもの: 会話のテンポ、短いリアクション、問題提起から実演へ移る構成、演出キューの粒度。",
			"- 転用禁止: 観測商品の名称、数値、性能、試験、専門家、お客様、特典、価格、固有の実演内容。",
			"- 下記の接続表現は語調の参考に限り、商品事実や根拠として使用しない。",
			...unique.map((phrase) => `  - ${phrase}`),
		].join("\n");
	} catch {
		return [
			"## 放送文体リファレンス",
			"- 文体資料を解析できないため、商品ブリーフと制作条件だけを使用する。",
		].join("\n");
	}
}

async function loadStyleBible(tenant: string = "mediaworks"): Promise<string> {
	const cached = _styleCache.get(tenant);
	if (cached) return cached;
	let content: string;
	try {
		content = await fs.readFile(path.join(STYLE_DIR, `${tenant}.json`), "utf-8");
	} catch {
		content = await fs.readFile(BASE_STYLE_BIBLE_PATH, "utf-8");   // fallback
	}
	const safeReference = buildSafeStyleReference(content);
	_styleCache.set(tenant, safeReference);
	return safeReference;
}

export const __test = { loadStyleBible, buildSafeStyleReference };

// ────────────────────────────────────────────────────────────────────────────
// SYSTEM INSTRUCTION — immutable role / output contract.
// Hard rule: output is 100% Japanese. No English anywhere.
// ────────────────────────────────────────────────────────────────────────────
function buildSystemInstructionText(actSection: string): string {
	return `
あなたはテレビ東京系「生活情報マーケット (テレ東ダイレクト)」のチーフ放送作家です。
20年以上、現役のテレビショッピング番組の構成・台本を執筆してきました。
あなたの仕事は、与えられた商品ブリーフから、生放送さながらの **完成版テレビショッピング台本** を Markdown で書き起こすこと。

# 出力言語の絶対ルール（最重要）

出力は **完全に日本語のみ**。
- 英語の単語・文章・括弧書きの英訳・英語の演出メモ・英語の章タイトル — **一切禁止**。
- 数字・ローマ字商品名（例: \`MIRAI-CLEAN\`）・物理単位（cm / g / ℃ / W / kg / Hz / ¥）は使用可。それ以外の英語は禁止。
- セリフの後ろに英訳をつけてはならない。
- 章タイトルに英語の副題（例: \`(The Hook & Problem Setup)\`）をつけてはならない。
- 演出メモ・感情メモ（\`(Authoritative, educational)\` 等）は **必ず日本語**で記述する。

# 役割と人格

- あなたは現場のスタジオ作家。視聴者の手元・耳元のリアクションを意識し、メリハリのある演出設計が得意。
- 視聴者：60代以上のシニアが中心。聞き取りやすい言葉・具体的な比較・繰り返しを大切にする。
- 番組：CMなし生放送。放送尺は商品ブリーフの指定を優先し、指定がなければ25分を目安にする。テロップ・カメラ・BGM・SEを使用する。

# 出力の絶対契約

出力は **Markdown 1本** のみ。前置き・後書き・コードフェンス（\`\`\`）禁止。
出力構造は **以下の順で必ず全セクションを含む**：

\`\`\`
# {商品名} — テレビショッピング 台本

## メタ情報
- 商品名:
- カテゴリ:
- 推定放送尺:
- ターゲット視聴者:
- キー・メッセージ:

## 構成
（全アクトの目的を箇条書きで日本語のみ）

## 本編

${actSection}
## 価格＆オファー
（Markdownテーブル）

\`\`\`

# 台詞の書式（厳守）

各台詞ブロックは **必ず** 以下の形式：

\`\`\`
[役名] （感情・演出メモを日本語で）
日本語のセリフ本文。
\`\`\`

セリフ本文の下に英訳を書かない。1行で完結する。

標準役名は以下を使用する。商品ブリーフの「追加の話者」に指定がある場合だけ、その役名も使用可能：
- \`[N]\` ナレーター（男性中年、語尾「…！」「…のです！」、テンポ早め）
- \`[高橋]\` 商品アドバイザー（冷静で権威的、専門用語を分かりやすく）
- \`[山内]\` MC（50代男性、視聴者目線、驚き役）
- \`[小島]\` MC（40代女性、共感役、主婦目線）
- \`[お客様]\` 一般家庭の愛用者（固有名で呼ぶ：例「片岡さん」）
- 専門家を出す場合は \`[XX先生]\` の形（例：\`[清水先生]\`）

# 演出キューの書式（厳守）

演出キューは独立ブロックで、台詞の間に挿入：

\`\`\`
[テロップ]
○ 大見出し（日本語）
● 補足（日本語）
※ 注意・出典（日本語）
\`\`\`

\`\`\`
[カメラ]
[1S] 山内のバストショット。眉間にしわを寄せて新聞を読む様子…
\`\`\`

\`\`\`
[BGM]
緊張感のあるストリングス系の楽曲がフェードイン。
\`\`\`

\`\`\`
[SE]
シューーーッ！（スチームの噴射音）
\`\`\`

その他に \`[インサート]\` \`[小道具]\` も使用可能。すべての記述は日本語のみ。

# 価格・オファーの事実保護

- 価格、割引額、送料、保証、特典、限定条件は、商品ブリーフに明記されたものだけを使用する。
- メーカー直販価格や過去価格の販売実績が確認できない場合、二重価格表示や「○円お得」を作らない。
- 商品ブリーフにない比較試験、試験機関、専門家、受賞歴、お客様の体験、専用品を創作しない。
- 「企画参考情報」は台本設計の参考に限り、確認済みの商品事実・数値・実績として断定しない。
- お客様の声がない場合は架空の氏名や体験談を作らず、「使用シーン／よくある疑問」のVTRへ置き換える。
- 未確認情報を台本に必要とする場合は断定せず、台本本文には混ぜずに該当要素を省略する。
- 電話番号は実値がない場合に限り 0120-XXX-XXX の制作プレースホルダーを使う。

# 禁止事項

- **英語の混入（最重要）**：セリフの英訳、英語の章副題、英語の演出メモ、英語のリアクション、英語の章タイトル、すべて禁止。1単語も入れない。
- SVG・図・画像タグの使用。
- JANコード・梱包サイズ・製造国・お手入れ方法など放送不要情報の混入。
- 文字数稼ぎの冗長な反復。
- 「以下、台本です」「以上が台本です」などの前後の地の文。
- コードフェンス（\`\`\`）の使用。
- 制作メモ、考査コメント、修正指示、コンプライアンス解説を台本本文へ混在させること。

# 文字密度

各アクトに最低3〜5の演出キュー、複数の話者ラインを織り交ぜる。
アクト境界は \`---\` で区切る。
密度は商品ブリーフで指定された放送尺に合わせる。指定がなければ25分相当を目指す。
`.trim();
}

/** The ten-act running order this project shipped with. Invented here, not
 *  taken from any MWB house format, so a measured competitor structure is free
 *  to replace it. */
const DEFAULT_ACT_SECTION = `### ■アバン — つかみと問題提起
（生活上の困りごとを提示。確認済みの専門家情報がある場合だけ権威付けに使用）

### ■スタジオ① — 導入と従来品との対比
（従来品との対比 → ドラマチック登場）

### ■スタジオ② — 実演（複数）
（商品ブリーフで確認できる特徴を、視覚的に理解できる実演で示す）

### ■CTA① — 最初の注文案内（約90秒）
（実演直後の納得感を受け、電話番号・注文方法・主要条件を案内）

### ■スタジオ③ — 反論処理と機能性
（想定異論を順に潰す + 機能のおまけ価値）

### ■スタジオ④ — 価格発表
（バリュースタック → 「お値段そのまま」落とし）

### ■CTA② — 価格と条件の注文案内（約90〜120秒）
（価格・送料・保証など、商品ブリーフで確認できる条件だけを案内）

### ■VTR — 使用シーン／確認済みのお客様の声
（お客様の声がブリーフにある場合だけ引用。なければ利用場面やよくある疑問を扱う）

### ■CTA③ — 最終案内（約60〜90秒）
（電話番号・注文方法・確認済みの条件を再提示）`;

/** Used when a competitor-pattern block is present.
 *
 *  Measured: with the fixed ten acts, injecting the pattern changed nothing.
 *  Three screenplays — two without the block, one with — produced an identical
 *  act list, and the with/without text distance (0.739) was indistinguishable
 *  from the distance between the two runs that had no block at all (0.733).
 *  The pattern said 実演 occupies 35% of the hour across four passes and that
 *  evidence is carried by 専門家 and 利用者の声 in 100% of programmes; the
 *  template gave 実演 one section and produced no expert or testimonial content
 *  in any run. The template was simply louder than the measurement.
 *
 *  So when a pattern exists, the running order comes from it. The document
 *  skeleton and every anti-fabrication rule stay exactly as they are. */
const PATTERN_DRIVEN_ACT_SECTION = `（アクト構成は「競合放送の構成パターン」に従って自分で組み立てる。以下を守ること）

- パターンに挙がったアクトを、記載された順序で並べる。各アクトの見出しは \`### ■{アクト名}\` とする。
- **1つの見出しには1つのアクトだけ**。「導入・価格初出」のように複数のアクトを1つの見出しへまとめてはならない。
- 「M回に分けて」とあるアクトは、番組内でM回に分けて登場させる。1か所にまとめない。2回目以降の見出しは \`### ■{アクト名}２\` のように通し番号を付ける。
- 「計N%」はそのアクトが尺全体に占める合計割合。指定の放送尺に換算し、M回に分ける場合はその合計がN%になるよう各回へ配分する。
- 見出しに書くのはアクト名と通し番号だけ。内容の要約や副題を付け足さない。
- 「根拠提示の型」に挙がった手段のうち、商品ブリーフで確認できるものだけを使う。確認できない専門家・お客様の声・試験結果は、割合が高くても作ってはならない。該当がなければ使用シーンやよくある疑問に置き換える。
- 「想定される視聴者の懸念」は、反論処理のアクトで扱う話題の候補として使う。
- 「オファー進行」の価格初出位置とCTA回数に合わせる。ただしCTAで案内してよいのは商品ブリーフで確認できる価格・送料・保証・特典だけ。
- パターンは構成の設計にのみ使う。競合商品の名称・数値・実演内容は含まれておらず、推測して補ってはならない。`;

/** `hasPattern` swaps the running order for one derived from measured
 *  competitor structure. Everything else in the contract is identical. */
export function buildSystemInstruction(hasPattern: boolean): string {
	return buildSystemInstructionText(hasPattern ? PATTERN_DRIVEN_ACT_SECTION : DEFAULT_ACT_SECTION);
}

/** Back-compat for callers with no pattern. */
export const SYSTEM_INSTRUCTION = buildSystemInstruction(false);

// ────────────────────────────────────────────────────────────────────────────
// PRODUCT BRIEF formatter
// ────────────────────────────────────────────────────────────────────────────
function formatProductBrief(b: ProductBrief): string {
	const lines: string[] = [];
	lines.push(`商品名: ${b.name}`);
	if (b.category) lines.push(`カテゴリ: ${b.category}`);
	lines.push("");
	lines.push("確認済み商品情報（台本で事実として使用可能）:");
	lines.push(b.description);
	if (b.price) {
		lines.push("");
		lines.push("価格情報:");
		if (b.price.listJpy) lines.push(`  メーカー直販価格: ¥${b.price.listJpy.toLocaleString()}`);
		if (b.price.saleJpy) lines.push(`  本日特別価格: ¥${b.price.saleJpy.toLocaleString()}`);
		if (b.price.shippingJpy != null) lines.push(`  送料: ¥${b.price.shippingJpy.toLocaleString()}`);
	}
	if (b.bonuses?.length) {
		lines.push("");
		lines.push("ボーナス・特典:");
		for (const x of b.bonuses) lines.push(`  - ${x}`);
	}
	if (b.guarantee) lines.push("", `保証: ${b.guarantee}`);
	if (b.notes) {
		lines.push(
			"",
			"企画参考情報（構成の参考のみ。商品事実・数値・実績として断定しない）:",
			b.notes,
		);
	}
	return lines.join("\n");
}

function formatCustomization(b: ProductBrief): string | null {
	const c = b.customization;
	if (!c) return null;
	const lines: string[] = [];
	lines.push("## ユーザー指定の作家指示（最優先で反映）");
	if (c.runtimeMinutes) lines.push(`- 目標放送尺: 約 ${c.runtimeMinutes} 分`);
	if (c.targetAudience) lines.push(`- ターゲット視聴者: ${c.targetAudience}`);
	if (c.keyMessage) lines.push(`- キー・メッセージ（必ず台本内で2回以上反復）: 「${c.keyMessage}」`);
	if (c.tonalAdjust) {
		const map: Record<string, string> = {
			calm: "落ち着いた・上品な",
			neutral: "標準的な",
			energetic: "高エネルギー・畳みかける",
		};
		lines.push(`- トーン: ${map[c.tonalAdjust] ?? c.tonalAdjust}テンポを基調にする`);
	}
	if (c.mustDemos?.length) {
		lines.push(`- **必須実演** (スタジオ② に必ず含める)：`);
		for (const d of c.mustDemos) lines.push(`  - ${d}`);
	}
	if (c.mustAvoid?.length) {
		lines.push(`- **禁止事項** (絶対にこれを言わない・しない)：`);
		for (const x of c.mustAvoid) lines.push(`  - ${x}`);
	}
	if (c.extraSpeakers?.length) {
		lines.push(`- **追加の話者** (デフォルトの N / 高橋 / 山内 / 小島 / お客様 に加えて使用可能)：`);
		for (const s of c.extraSpeakers) lines.push(`  - [${s.role}] — ${s.description}`);
	}
	return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// USER PROMPT — per-product, mode-specific.
// ────────────────────────────────────────────────────────────────────────────
export async function buildUserPrompt(input: GenerateInput): Promise<string> {
	const styleBible = await loadStyleBible();
	const productBlock = formatProductBrief(input.productBrief);
	const customBlock = formatCustomization(input.productBrief);

	if (input.mode === "initial") {
		const parts = [
			"# タスク：新規台本の起稿",
			"商品ブリーフから、完成版テレビショッピング台本を **100%日本語で** 起こせ。",
			"出力は SYSTEM INSTRUCTION で指定したセクション順・密度・書式を厳守すること。",
			"",
			"---",
			"",
			"## 商品ブリーフ",
			"",
			productBlock,
			"",
			"## 根拠の優先順位",
			"1. 確認済み商品情報・価格・特典・保証",
			"2. ユーザー指定の作家指示",
			...(input.structurePlanBlock?.trim()
				? ["3. 確定済み放送構成（区分・順序・尺配分は変更しない）"]
				: []),
			...(input.patternBlock?.trim()
				? [
					"4. 競合放送の構成パターン（構成の骨格のみ。商品事実として使用しない）",
					"5. 企画参考情報（構成だけに使用し、事実として断定しない）",
					"6. 放送文体リファレンス（リズムだけに使用し、内容を転用しない）",
				]
				: [
					"4. 企画参考情報（構成だけに使用し、事実として断定しない）",
					"5. 放送文体リファレンス（リズムだけに使用し、内容を転用しない）",
				]),
			"根拠が足りない要素は創作せず、省略または一般的な使用シーンに置き換える。",
		];
		if (customBlock) parts.push("", "---", "", customBlock);
		const complianceInitial = input.complianceBlock?.trim();
		if (complianceInitial) parts.push("", "---", "", "--- 必須遵守 ---", "", complianceInitial);
		// Before the competitor pattern on purpose: the plan is the decision the
		// pattern already fed into, so a writer reading downward meets the
		// conclusion first and the aggregate second.
		const structureInitial = input.structurePlanBlock?.trim();
		if (structureInitial) parts.push("", "---", "", structureInitial);
		const patternInitial = input.patternBlock?.trim();
		if (patternInitial) parts.push("", "---", "", patternInitial);
		parts.push(
			"",
			"---",
			"",
			"## 放送文体の限定リファレンス",
			"",
			styleBible.slice(0, 5000),
			"",
			"---",
			"",
			"## 出力",
			"100%日本語の完成版 Markdown 台本のみを出力。前置き・後書き・コードフェンス・英語禁止。",
		);
		return parts.join("\n");
	}

	const feedback = input.feedback?.trim();
	const previous = input.previousMarkdown?.trim();
	if (!feedback) throw new Error("refine mode requires feedback");
	if (!previous) throw new Error("refine mode requires previousMarkdown");

	const parts = [
		"# タスク：台本の改稿（リライト）",
		"下記の【現在の台本】をベースに、【ディレクターからのフィードバック】を最優先で反映し、",
		"**全セクションを含む完成版** を 100% 日本語で出力せよ。差分ではなく全文出力。",
		"",
		"フィードバックで言及されなかった他のセクションは前バージョンを尊重しつつ、",
		"自然な流れになるよう微調整は許容。構成の骨格は維持。",
		"",
			"前バージョンに英語が混入していても、改稿後の出力には英語を一切含めてはならない。",
			"フィードバックで変更範囲が指定されている場合、その範囲以外の文言と事実は原則として変更しない。",
			"【保護する内容】に書かれた商品事実・価格・必須注記は厳守し、根拠のない補完をしない。",
			"考査の説明、修正方針、作業メモは台本本文へ書かず、放送で読む本文と演出キューだけを出力する。",
		"",
		"---",
		"",
		"## ディレクターからのフィードバック（最優先）",
		"",
		feedback,
		"",
		"---",
		"",
		"## 現在の台本（このバージョンをベースに改稿）",
		"",
		previous,
		"",
		"---",
		"",
		"## 商品ブリーフ",
		"",
		productBlock,
	];
	if (customBlock) parts.push("", "---", "", customBlock);
	const complianceRefine = input.complianceBlock?.trim();
	if (complianceRefine) parts.push("", "---", "", "--- 必須遵守 ---", "", complianceRefine);
	// A refine inherits the base version's plan. Feedback may change what is
	// SAID in a section; it does not silently reorder the broadcast.
	const structureRefine = input.structurePlanBlock?.trim();
	if (structureRefine) parts.push("", "---", "", structureRefine);
	parts.push(
		"",
		"---",
		"",
		"## 放送文体の限定リファレンス",
		"",
		styleBible.slice(0, 3000),
		"",
		"---",
		"",
		"## 出力",
		"100%日本語の改稿版 Markdown 台本のみを出力。前後の説明・コードフェンス・英語禁止。",
	);
	return parts.join("\n");
}

export async function buildPrompt(input: GenerateInput): Promise<string> {
	return await buildUserPrompt(input);
}
