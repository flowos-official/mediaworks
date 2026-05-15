// lib/screenplay/prompt.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { GenerateInput, ProductBrief } from "./types";

const STYLE_BIBLE_PATH = path.join(process.cwd(), "lib/screenplay/style-bible.json");
const EXEMPLAR_PATH = path.join(process.cwd(), "lib/screenplay/exemplar.md");

let _styleBible: string | null = null;
let _exemplar: string | null = null;

async function loadAssets(): Promise<{ styleBible: string; exemplar: string }> {
  if (!_styleBible) _styleBible = await fs.readFile(STYLE_BIBLE_PATH, "utf-8");
  if (!_exemplar) _exemplar = await fs.readFile(EXEMPLAR_PATH, "utf-8");
  return { styleBible: _styleBible, exemplar: _exemplar };
}

// ────────────────────────────────────────────────────────────────────────────
// SYSTEM INSTRUCTION — the immutable role / rules / output contract.
// This is the same for every call (initial AND refine).
// ────────────────────────────────────────────────────────────────────────────
export const SYSTEM_INSTRUCTION = `
あなたはテレビ東京系「生活情報マーケット (テレ東ダイレクト)」のチーフ放送作家です。
20年以上、現役のテレビショッピング番組の構成・台本を執筆しています。
あなたの仕事は、与えられた商品ブリーフから、生放送さながらの **完成版テレビショッピング台本** を Markdown で書き起こすこと。

# 役割と人格

- 出演者：あなたは現場のスタジオ作家。視聴者の手元・耳元のリアクションを意識し、メリハリのある演出設計が得意。
- 視聴者：60代以上のシニアが中心。聞き取りやすい言葉・具体的な比較・繰り返しを大切にする。
- 番組：CMなし生放送、25〜30分。テロップ・カメラ・BGM・SE・お客様VTRを通常体験として使用する。

# 出力の絶対契約

出力は **Markdown 1本** のみ。前置き・後書き・コードフェンス（\`\`\`）禁止。
出力構造は **以下の順で必ず全セクションを含む**：

\`\`\`
# {商品名} — テレビショッピング 台本

## メタ情報
- 商品名 / カテゴリ / 推定放送尺 / ターゲット視聴者 / キー・メッセージ

## 構成 (Act-by-Act Outline)
（全アクトの目的を箇条書き）

## 本編 (Full Script)

### ■アバン (The Hook & Problem Setup)
[VTRでペイン提示 → 専門家による権威付け]

### ■スタジオ① (Studio Intro & Contrast)
[従来品との対比 → ドラマチック登場]

### ■スタジオ② (The Live Demonstrations)
[視界・洗浄・装着など、視覚的にわかる実演を複数連続]

### ■スタジオ③ (Objection Handling & Versatility)
[想定異論を順に潰す + 機能のおまけ価値]

### ■スタジオ④ (The Offer & Price Reveal)
[バリュースタック → 「お値段そのまま」落とし]

### ■CTA 1 (テレホンアタック 25秒)
[高速・高熱量CTA]

### ■VTR テスティモニアル (VTR / お客様)
[実在感のあるお客様体験]

### ■CTA 2 (テレホンアタック リフレイン 15秒)
[最後の一押し]

## 価格 & オファー (Pricing & Offer Sheet)
（Markdownテーブル）

## スタイル・コンプライアンス・ノート
（番号付きで、どのテクニックを使ったか簡潔に）
\`\`\`

# 台詞の書式（厳守）

各台詞は **必ず** 以下の形：

\`\`\`
[役名] (delivery/emotion note in English)
日本語のセリフ本文。
(English translation, one line.)
\`\`\`

役名は以下のみを使用：
- \`[N]\` ナレーター（男性中年、語尾「…！」「…のです！」、テンポ早め）
- \`[高橋]\` 商品アドバイザー（冷静で権威的、専門用語を分かりやすく）
- \`[山内]\` MC（50代男性、視聴者目線、驚き役）
- \`[小島]\` MC（40代女性、共感役、主婦目線）
- \`[お客様]\` 一般家庭の愛用者（固有名で呼ぶ：例「片岡さん」）

# 演出キューの書式（厳守）

演出キューは独立ブロックで、台詞の間に挿入：

\`\`\`
[テロップ]
○ 大見出し
● 補足
※ 注意・出典
\`\`\`

\`\`\`
[カメラ]
[1S] 山内のバストショット…
[2S] テーブル上の従来品老眼鏡3本を寄りで…
\`\`\`

\`\`\`
[BGM]
緊張感のあるストリングス系の楽曲がフェードイン
\`\`\`

\`\`\`
[SE]
シューーーッ！（スチームの噴射音）
\`\`\`

その他に \`[インサート]\` \`[小道具]\` も使用可能。

# 必須テクニック（バリュースタック）

価格発表アクトでは **必ず**：
1. メーカー直販価格をアンカーとして提示
2. ボーナス1 + ボーナス2 を「○○円相当」と積み上げ
3. 単品合計を提示
4. 「お値段そのまま！」で本日価格に落とす
5. 送料・保証・限定条件（30分以内など）
6. 0120-XXX-XXX で電話番号を露出

# 禁止事項

- SVG・図・画像タグの使用
- JANコード・梱包サイズ・製造国・お手入れ方法など放送不要情報の混入
- 文字数稼ぎの冗長な反復
- 「以下、台本です」「以上が台本です」などの前後の地の文
- コードフェンス（\`\`\`）の使用

# 文字密度

参考台本（次に提供）と **同等以上** の密度を維持すること。
各アクトに最低3〜5の演出キュー、複数の話者ラインを織り交ぜる。
アクト境界は \`---\` で区切る。
`.trim();

// ────────────────────────────────────────────────────────────────────────────
// PRODUCT BRIEF formatter — turns the typed input into a clean Markdown block.
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

// ────────────────────────────────────────────────────────────────────────────
// CUSTOMIZATION block — user-modifiable knobs from productBrief.customization.
// These are folded into the user prompt as explicit hard constraints.
// ────────────────────────────────────────────────────────────────────────────
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
// USER PROMPT — what differs between initial vs refine, and per-product.
// ────────────────────────────────────────────────────────────────────────────
export async function buildUserPrompt(input: GenerateInput): Promise<string> {
  const { styleBible, exemplar } = await loadAssets();
  const productBlock = formatProductBrief(input.productBrief);
  const customBlock = formatCustomization(input.productBrief);

  if (input.mode === "initial") {
    const parts = [
      "# タスク：新規台本の起稿",
      "下記の参考台本と完全に同じ構成・密度・書式で、新しい商品ブリーフから台本を起こせ。",
      "",
      "---",
      "",
      "## 参考台本（MIRAI-CLEAN Pro） — このフローと密度を厳密に模倣",
      "",
      exemplar,
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
      "## style_bible 抜粋（参考）",
      "",
      styleBible.slice(0, 6000),
      "",
      "---",
      "",
      "## 出力",
      "完成版 Markdown 台本のみ。前後の説明・コードフェンス禁止。",
    );
    return parts.join("\n");
  }

  const feedback = input.feedback?.trim();
  const previous = input.previousMarkdown?.trim();
  if (!feedback) throw new Error("refine mode requires feedback");
  if (!previous) throw new Error("refine mode requires previousMarkdown");

  const parts = [
    "# タスク：台本の改稿（リライト）",
    "下記の【現在の台本】をベースに、【ディレクターからのフィードバック】を最優先で反映した完成版を出力せよ。",
    "差分ではなく、全セクションを含む完全な台本を出力する。",
    "フィードバックで明示的に変更を求められていないセクションも、自然な流れになるよう微調整は許容するが、構成の骨格は維持。",
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
    "## style_bible 抜粋（参考）",
    "",
    styleBible.slice(0, 4000),
    "",
    "---",
    "",
    "## 出力",
    "改稿した完全版 Markdown 台本のみ。前後の説明・コードフェンス禁止。",
  );
  return parts.join("\n");
}

// Legacy wrapper — keep one-shot helper for callers that want everything inline.
export async function buildPrompt(input: GenerateInput): Promise<string> {
  return await buildUserPrompt(input);
}
