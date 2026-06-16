// lib/screenplay/import/normalize-prompt.ts
// Structure-only normalization contract for importing an existing draft script.
// Deliberately NOT the generation SYSTEM_INSTRUCTION: that one forces the full
// アバン/スタジオ①〜④/CTA/VTR/価格 skeleton. Import must NEVER invent absent sections.
// No "server-only" import — must load under tsx smoke scripts.
import type { ProductBrief } from "../types";
import { parseBriefObject } from "../extract/brief-prompt";
import { IMPORT_MARKDOWN_MAX } from "./constants";

export { IMPORT_MARKDOWN_MAX };

export interface NormalizedDraft {
  markdown: string;
  brief: ProductBrief;
}

export const IMPORT_SYSTEM_INSTRUCTION = `あなたは日本のテレビショッピング台本の編集アシスタントです。
ユーザーが Word で作成した「既存の台本ドラフト」を、当システムの標準フォーマットに **構造だけ** 整形します。

# 絶対原則（最重要）
- これは「忠実な取り込み」です。原文の文言・セリフ・情報を **保持** してください。
- 要約・加筆・品質改善・コンプライアンス上の言い換えは **禁止**。文章を書き換えないこと。
- 原文に **存在しないセクション**（CTA・お客様VTR・価格表・メタ情報・スタイルノート等）を **新規に作ってはいけません**。原文にあるものだけを残す。
- 原文の言語をそのまま保持。翻訳しない。英語を消したり足したりしない。

# あなたの仕事は「構造のタグ付け」だけ
入力テキスト（プレーンテキストまたは HTML。HTML の場合は表のセル境界が話者と台詞の区切りを表す）を読み、当システムの Markdown タグに割り当て直す：

- 見出し: \`#\` / \`##\` / \`###\`
- 場面転換・アクト境界: \`---\`
- 話者ブロックは必ず次の形式（1行で完結）：
  [役名] （演出メモがあれば日本語で）
  セリフ本文
  役名タグは **必ず次の5種のいずれか** に正規化する（システムが認識できるのはこの5種のみ）：
  [N]（ナレーター） [高橋]（商品アドバイザー・権威役） [山内]（MC・驚き役） [小島]（MC・共感役） [お客様]（愛用者）。
  原文の話者がこの5種に **きれいに対応しない** 場合（例：専門家「清水先生」、固有名のお客様「片岡さん」）は、最も近い役（専門家→[高橋]、名前付きお客様→[お客様] 等）に割り当て、**元の名前は演出メモ（）に保持する**（例：[お客様] （片岡さん・実感を込めて））。独自の [名前] タグや [XX先生] タグは出力しないこと（パーサが認識せず、ただの段落として表示されてしまう）。
- 演出キューは独立ブロック：[テロップ] [カメラ] [BGM] [SE] [インサート] [小道具]。
  原文にそれらの指示があれば対応するタグに入れる。無ければ作らない。

# 商品情報 (brief) の抽出
台本本文から読み取れる範囲で ProductBrief を抽出する（捏造禁止、不明項目は省略）。
- name: 商品名（必須。台本から判断できる正式名称に最も近いもの）
- description: 台本から読み取れる商品の特徴・訴求を 200〜2000 文字程度の日本語で要約
- category / price(listJpy/saleJpy/shippingJpy は日本円の整数) / bonuses[] / guarantee / notes は分かる場合のみ

# 出力
厳密な JSON のみ。前置き・説明・コードフェンス禁止。
{
  "markdown": "整形済みの台本全文（原文の文言を保持）",
  "brief": { "name": string, "category"?: string, "description": string, "price"?: { "listJpy"?: number, "saleJpy"?: number, "shippingJpy"?: number }, "bonuses"?: string[], "guarantee"?: string, "notes"?: string }
}`;

export function parseImportJson(text: string): NormalizedDraft {
  const trimmed = text.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini did not return JSON");
  const obj = JSON.parse(match[0]) as Record<string, unknown>;

  const markdown = typeof obj.markdown === "string" ? obj.markdown.trim() : "";
  if (!markdown) throw new Error("正規化結果に台本本文 (markdown) がありません");
  // Faithful import: NEVER silently truncate. Reject over-limit with a clear error.
  if (markdown.length > IMPORT_MARKDOWN_MAX) {
    throw new Error(`正規化後の台本が長すぎます（${IMPORT_MARKDOWN_MAX.toLocaleString()} 文字以内にしてください）`);
  }

  if (!obj.brief || typeof obj.brief !== "object") {
    throw new Error("正規化結果に商品情報 (brief) がありません");
  }
  const brief = parseBriefObject(obj.brief as Record<string, unknown>);

  return { markdown, brief };
}
