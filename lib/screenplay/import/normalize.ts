// lib/screenplay/import/normalize.ts
// One Gemini call: raw draft text → { markdown, brief }. Mirrors extract/from-pdf.ts.
// No "server-only" — importable from tsx smoke scripts.
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import { IMPORT_SYSTEM_INSTRUCTION, parseImportJson, type NormalizedDraft } from "./normalize-prompt";

const MODEL = GEMINI_FLASH;

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

export async function normalizeDraft(rawText: string, fileName: string): Promise<NormalizedDraft> {
  const model = getGenAI().getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json" },
    systemInstruction: IMPORT_SYSTEM_INSTRUCTION,
  });

  const prompt = `次の既存台本ドラフトを、当システムの標準フォーマットに構造だけ整形してください。
ファイル名: ${fileName}

原文の文言は保持し、原文に無いセクションは作らないこと。

--- ドラフト本文 ---
${rawText}`;

  const result = await model.generateContent([{ text: prompt }]);
  const text = result.response.text();
  return parseImportJson(text);
}
