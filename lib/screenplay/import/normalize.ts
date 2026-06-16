// lib/screenplay/import/normalize.ts
// One Gemini call: raw draft text → { markdown, brief }. Mirrors extract/from-pdf.ts.
// No "server-only" — importable from tsx smoke scripts.
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import { IMPORT_SYSTEM_INSTRUCTION, parseImportJson, type NormalizedDraft } from "./normalize-prompt";

const MODEL = GEMINI_FLASH;

// The import normalizer returns the ENTIRE script as JSON (unlike the brief
// extractor, which returns a short summary). The model's default output budget
// (~8k tokens) truncates a full-length script mid-JSON → parse failure. Give it
// plenty of headroom; the MAX_TOKENS guard below still catches anything larger.
const MAX_OUTPUT_TOKENS = 65536;

/** Thrown when the model truncates output at the token limit (draft too long).
 *  The route surfaces this message verbatim — it carries no provider internals. */
export class DraftTooLongError extends Error {
  constructor() {
    super("台本が長すぎて整形しきれませんでした。短く分割してからお試しください。");
    this.name = "DraftTooLongError";
  }
}

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

export async function normalizeDraft(rawText: string, fileName: string): Promise<NormalizedDraft> {
  const model = getGenAI().getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: MAX_OUTPUT_TOKENS },
    systemInstruction: IMPORT_SYSTEM_INSTRUCTION,
  });

  const prompt = `次の既存台本ドラフトを、当システムの標準フォーマットに構造だけ整形してください。
ファイル名: ${fileName}

原文の文言は保持し、原文に無いセクションは作らないこと。

--- ドラフト本文 ---
${rawText}`;

  const result = await model.generateContent([{ text: prompt }]);
  // If output hit the cap, the JSON is truncated → fail with a clear, actionable
  // message instead of an opaque parse error.
  if (result.response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new DraftTooLongError();
  }
  const text = result.response.text();
  return parseImportJson(text);
}
