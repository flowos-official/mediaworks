// lib/screenplay/prompt.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { GenerateInput, ProductBrief } from "./types";

const STYLE_BIBLE_PATH = path.join(process.cwd(), "lib/screenplay/style-bible.json");

let _styleBible: string | null = null;

async function loadStyleBible(): Promise<string> {
	if (!_styleBible) _styleBible = await fs.readFile(STYLE_BIBLE_PATH, "utf-8");
	return _styleBible;
}

// ────────────────────────────────────────────────────────────────────────────
// SYSTEM INSTRUCTION — immutable role / output contract.
// Hard rule: output is 100% Japanese. No English anywhere.
// ────────────────────────────────────────────────────────────────────────────
export const SYSTEM_INSTRUCTION = `
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
- 番組：CMなし生放送、25〜30分。テロップ・カメラ・BGM・SE・お客様VTRを通常体験として使用する。

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

### ■アバン — つかみと問題提起
（VTRでペイン提示 → 専門家による権威付け）

### ■スタジオ① — 導入と従来品との対比
（従来品との対比 → ドラマチック登場）

### ■スタジオ② — 実演（複数）
（視界・洗浄・装着など、視覚的にわかる実演を複数連続）

### ■スタジオ③ — 反論処理と機能性
（想定異論を順に潰す + 機能のおまけ価値）

### ■スタジオ④ — 価格発表
（バリュースタック → 「お値段そのまま」落とし）

### ■CTA①（テレホンアタック 約25秒）
（高速・高熱量の電話喚起）

### ■VTR — お客様の声
（実在感のあるお客様体験）

### ■CTA②（リフレイン 約15秒）
（最後の一押し）

## 価格＆オファー
（Markdownテーブル）

## スタイル・コンプライアンス・ノート
（番号付きで、どのテクニックを使ったか簡潔に）
\`\`\`

# 台詞の書式（厳守）

各台詞ブロックは **必ず** 以下の形式：

\`\`\`
[役名] （感情・演出メモを日本語で）
日本語のセリフ本文。
\`\`\`

セリフ本文の下に英訳を書かない。1行で完結する。

役名は以下のいずれかのみを使用：
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

# 必須テクニック（バリュースタック）

価格発表アクトでは **必ず**：
1. メーカー直販価格をアンカーとして提示
2. ボーナス1 + ボーナス2 を「○○円相当」と積み上げ
3. 単品合計を提示
4. 「お値段そのまま！」で本日価格に落とす
5. 送料・保証・限定条件（30分以内など）
6. 0120-XXX-XXX で電話番号を露出

# 禁止事項

- **英語の混入（最重要）**：セリフの英訳、英語の章副題、英語の演出メモ、英語のリアクション、英語の章タイトル、すべて禁止。1単語も入れない。
- SVG・図・画像タグの使用。
- JANコード・梱包サイズ・製造国・お手入れ方法など放送不要情報の混入。
- 文字数稼ぎの冗長な反復。
- 「以下、台本です」「以上が台本です」などの前後の地の文。
- コードフェンス（\`\`\`）の使用。

# 文字密度

各アクトに最低3〜5の演出キュー、複数の話者ラインを織り交ぜる。
アクト境界は \`---\` で区切る。
密度は実放送の25〜30分尺に相当する量を目指す。
`.trim();

// ────────────────────────────────────────────────────────────────────────────
// PRODUCT BRIEF formatter
// ────────────────────────────────────────────────────────────────────────────
function formatProductBrief(b: ProductBrief): string {
	const lines: string[] = [];
	lines.push(`商品名: ${b.name}`);
	if (b.category) lines.push(`カテゴリ: ${b.category}`);
	lines.push("");
	lines.push("特徴・スペック:");
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
	if (b.notes) lines.push("", "その他のメモ:", b.notes);
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
		];
		if (customBlock) parts.push("", "---", "", customBlock);
		parts.push(
			"",
			"---",
			"",
			"## style_bible 抜粋（参考。出力には英語を含めないこと）",
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
	parts.push(
		"",
		"---",
		"",
		"## style_bible 抜粋（参考。出力には英語を含めないこと）",
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
