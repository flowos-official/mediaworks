// lib/screenplay/extract/brief-prompt.ts
import type { ProductBrief } from "../types";

export const EXTRACT_SYSTEM_INSTRUCTION = `あなたは日本のテレビショッピング向け台本制作のアシスタントです。
与えられた素材（商品PDF・スプレッドシート・WEBページのテキスト）から、
台本生成の入力となる ProductBrief を厳密に抽出します。

ルール:
- 出力は厳密な JSON のみ。前置きや説明、コードフェンスは禁止。
- 不明な項目は省略（null/undefined を入れない）。捏造禁止。
- price は日本円の整数（¥や,を除去）。listJpy=メーカー直販価格, saleJpy=本日特別価格, shippingJpy=送料。
- bonuses は配列（特典・付属品）。文字列ごとに 1 件。
- description は商品の特徴・スペック・訴求ポイントを 200〜2000 文字程度で日本語にまとめる。元素材が日本語以外なら日本語に要約する。
- name は必ず日本語表記の正式名称（不明なら最も商品名に近い見出し）。
- notes には台本制作に役立つ追加情報（販売実績、賞、安全規格、互換性など）があればまとめる。

返却スキーマ:
{
  "name": string,
  "category"?: string,
  "description": string,
  "price"?: { "listJpy"?: number, "saleJpy"?: number, "shippingJpy"?: number },
  "bonuses"?: string[],
  "guarantee"?: string,
  "notes"?: string
}`;

export interface ExtractedBriefResult {
  brief: ProductBrief;
  rawJson: string;
}

export function parseBriefJson(text: string): ProductBrief {
  const trimmed = text.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini did not return JSON");
  const obj = JSON.parse(match[0]) as Record<string, unknown>;

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  if (!name) throw new Error("抽出結果に商品名がありません");
  if (!description) throw new Error("抽出結果に商品説明がありません");

  const brief: ProductBrief = { name: name.slice(0, 200), description: description.slice(0, 16_000) };

  if (typeof obj.category === "string" && obj.category.trim()) {
    brief.category = obj.category.trim().slice(0, 200);
  }
  if (typeof obj.guarantee === "string" && obj.guarantee.trim()) {
    brief.guarantee = obj.guarantee.trim().slice(0, 500);
  }
  if (typeof obj.notes === "string" && obj.notes.trim()) {
    brief.notes = obj.notes.trim().slice(0, 4000);
  }
  if (Array.isArray(obj.bonuses)) {
    const bonuses = obj.bonuses
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, 20)
      .map((s) => s.trim().slice(0, 200));
    if (bonuses.length) brief.bonuses = bonuses;
  }
  if (obj.price && typeof obj.price === "object") {
    const p = obj.price as Record<string, unknown>;
    const num = (v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
      if (typeof v === "string") {
        const n = Number(v.replace(/[, ¥円\s]/g, ""));
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      }
      return undefined;
    };
    const list = num(p.listJpy);
    const sale = num(p.saleJpy);
    const shipping = num(p.shippingJpy);
    const price: NonNullable<ProductBrief["price"]> = {};
    if (list !== undefined) price.listJpy = list;
    if (sale !== undefined) price.saleJpy = sale;
    if (shipping !== undefined) price.shippingJpy = shipping;
    if (Object.keys(price).length) brief.price = price;
  }
  return brief;
}
