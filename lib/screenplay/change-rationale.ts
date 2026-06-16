// lib/screenplay/change-rationale.ts
// Gemini: explain WHY each computed diff hunk changed (it does not re-derive the
// changes — it annotates the hunks it is given). No "server-only" — matches the
// repo convention for Gemini modules with a tsx smoke (extract/from-pdf.ts,
// import/normalize.ts). Imported ONLY by the changes route; the client never
// imports it (it uses the endpoint + shared types in types.ts).
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import type { DiffHunk, HunkReason } from "./types";
import type { Finding } from "./compliance/types";

// Bump when the prompt below changes (part of the change_notes cache key).
export const PROMPT_VERSION = 1;

const SYSTEM_INSTRUCTION = `あなたはテレビショッピング台本の改稿レビュー補助です。
すでに計算済みの「変更箇所(hunk)」が与えられます。各 hunk について、なぜそう変更されたのかを日本語で一行で説明してください。

ルール:
- 出力は厳密な JSON 配列のみ。前置き・コードフェンス禁止。形式: [{"index": number, "reason": string}]
- 理由は「改稿の指示」と「直前バージョンの試験指摘」に基づいて述べる。
- 指示にも指摘にも結びつかない変更は "文体・表現の調整" とする。コンプライアンス上の理由を捏造しない。
- 与えられた hunk の index 以外は出力しない。各 reason は60文字以内。`;

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

export function parseHunkReasons(text: string, hunkCount: number): HunkReason[] {
  const match = text.trim().match(/\[[\s\S]*\]/);
  if (!match) throw new Error("rationale response had no JSON array");
  const arr = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(arr)) throw new Error("rationale response was not an array");
  const out: HunkReason[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const index = typeof o.index === "number" ? o.index : Number(o.index);
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    if (Number.isInteger(index) && index >= 0 && index < hunkCount && reason) {
      out.push({ index, reason: reason.slice(0, 300) });
    }
  }
  return out;
}

export async function explainChanges(
  hunks: DiffHunk[],
  feedback: string | null,
  findings: Finding[],
): Promise<HunkReason[]> {
  if (hunks.length === 0) return [];
  const model = getGenAI().getGenerativeModel({
    model: GEMINI_FLASH,
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096 },
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  const hunkBlock = hunks
    .map((h) => {
      const removed = h.lines.filter((l) => l.type === "removed").map((l) => l.text).join("\n");
      const added = h.lines.filter((l) => l.type === "added").map((l) => l.text).join("\n");
      return `## hunk ${h.index}\n--- 削除 ---\n${removed || "(なし)"}\n--- 追加 ---\n${added || "(なし)"}`;
    })
    .join("\n\n");
  const findingsBlock = findings.length
    ? findings.map((f) => `- [${f.axis}/${f.severity}] 「${f.quote}」: ${f.reason}`).join("\n")
    : "(指摘なし)";

  const prompt = `改稿の指示: ${feedback?.trim() || "(指示なし)"}

直前バージョンの試験指摘:
${findingsBlock}

変更箇所:
${hunkBlock}`;

  const result = await model.generateContent([{ text: prompt }]);
  return parseHunkReasons(result.response.text(), hunks.length);
}
