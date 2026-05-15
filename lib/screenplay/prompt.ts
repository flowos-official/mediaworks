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
    for (const b1 of b.bonuses) lines.push(`  - ${b1}`);
  }
  if (b.guarantee) lines.push("", `保証: ${b.guarantee}`);
  if (b.notes) lines.push("", "その他のメモ:", b.notes);
  return lines.join("\n");
}

export async function buildPrompt(input: GenerateInput): Promise<string> {
  const { styleBible, exemplar } = await loadAssets();
  const productBlock = formatProductBrief(input.productBrief);

  const sharedRules = `
あなたはテレビ東京系「生活情報マーケット (テレ東ダイレクト)」のチーフ放送作家です。
完成版テレビショッピング台本を Markdown で書く。【参考台本】と同じセクション構成・同じ密度・同じ書式で。

【必ず守るセクション順】
1. \u0060# {商品名} — テレビショッピング 台本\u0060
2. \u0060## メタ情報\u0060 （商品名 / カテゴリ / 推定放送尺 / ターゲット視聴者 / キー・メッセージ）
3. \u0060## 構成 (Act-by-Act Outline)\u0060
4. \u0060## 本編 (Full Script)\u0060 の中に **この順で**：
   - \u0060### ■アバン (The Hook & Problem Setup)\u0060
   - \u0060### ■スタジオ① (Studio Intro & Contrast)\u0060
   - \u0060### ■スタジオ② (The Live Demonstrations)\u0060
   - \u0060### ■スタジオ③ (Objection Handling & Versatility)\u0060
   - \u0060### ■スタジオ④ (The Offer & Price Reveal)\u0060
   - \u0060### ■CTA 1 (テレホンアタック 25秒)\u0060
   - \u0060### ■VTR テスティモニアル (VTR / お客様)\u0060
   - \u0060### ■CTA 2 (テレホンアタック リフレイン 15秒)\u0060
5. \u0060## 価格 & オファー (Pricing & Offer Sheet)\u0060 (Markdownテーブル)
6. \u0060## スタイル・コンプライアンス・ノート\u0060

【書式】
- 役名は \u0060[N]\u0060 ナレーター / \u0060[高橋]\u0060 商品アドバイザー / \u0060[山内]\u0060 MC（驚き役） / \u0060[小島]\u0060 MC（共感役） / \u0060[お客様]\u0060
- 役名の後に \u0060(感情・演出メモ in English)\u0060 を1行
- 直下に日本語セリフ → その下のかっこ内に英訳 1行
- 演出キュー: \u0060[テロップ]\u0060, \u0060[カメラ]\u0060, \u0060[BGM]\u0060, \u0060[SE]\u0060
- テロップ箇条書きは ○ ● ※ の3階層（必須）
- アクト境界は \u0060---\u0060 で区切る
- **SVG・図・画像タグ一切禁止。視覚情報はテキストとテロップで表現。**
- 不必要な情報（JANコード、梱包サイズ、お手入れ等）はカット。

【密度】参考台本と同等以上。各アクトに最低3〜5の演出キュー、複数の話者ライン。
`.trim();

  if (input.mode === "initial") {
    return [
      sharedRules,
      "",
      "---",
      "",
      "【参考台本（MIRAI-CLEAN Pro）— 構成・密度・書式を厳密に模倣】",
      "",
      exemplar,
      "",
      "---",
      "",
      "【商品情報】",
      "",
      productBlock,
      "",
      "---",
      "",
      "【style_bible 抜粋】",
      "",
      styleBible.slice(0, 8000),
      "",
      "---",
      "",
      "【出力】完成版 Markdown 台本のみ。前後の説明・コードフェンス禁止。",
    ].join("\n");
  }

  const feedback = input.feedback?.trim();
  const previous = input.previousMarkdown?.trim();
  if (!feedback) throw new Error("refine mode requires feedback");
  if (!previous) throw new Error("refine mode requires previousMarkdown");
  return [
    sharedRules,
    "",
    "---",
    "",
    "【現在の台本（このバージョンをベースに改稿）】",
    "",
    previous,
    "",
    "---",
    "",
    "【ディレクターからのフィードバック — このフィードバックを最優先で反映】",
    "",
    feedback,
    "",
    "---",
    "",
    "【商品情報】",
    "",
    productBlock,
    "",
    "---",
    "",
    "【style_bible 抜粋】",
    "",
    styleBible.slice(0, 6000),
    "",
    "---",
    "",
    "【出力】",
    "フィードバックを反映した、全セクション込みの完成版 Markdown 台本のみを出力。",
    "差分ではなく完全版。前後の説明・コードフェンス禁止。",
    "フィードバックで言及されなかった他のセクションは前バージョンを尊重しつつ、自然な流れになるよう微調整は許容。",
  ].join("\n");
}
