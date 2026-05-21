// lib/screenplay/extract/from-pdf.ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import { EXTRACT_SYSTEM_INSTRUCTION, parseBriefJson } from "./brief-prompt";
import type { ProductBrief } from "../types";

const MODEL = GEMINI_FLASH;

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

// Accepted mime types for inline Gemini Vision extraction.
export const SUPPORTED_VISION_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export async function extractBriefFromFile(
  fileBase64: string,
  mimeType: string,
  fileName: string,
): Promise<ProductBrief> {
  if (!SUPPORTED_VISION_MIME.has(mimeType)) {
    throw new Error(`非対応のファイル形式: ${mimeType}`);
  }
  const model = getGenAI().getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json" },
    systemInstruction: EXTRACT_SYSTEM_INSTRUCTION,
  });

  const prompt = `次の素材から ProductBrief を JSON で抽出してください。
ファイル名: ${fileName}

商品情報が複数ある場合は、もっとも主要・代表的な商品を 1 件だけ選んで抽出してください。`;

  const result = await model.generateContent([
    { inlineData: { mimeType, data: fileBase64 } },
    { text: prompt },
  ]);
  const text = result.response.text();
  return parseBriefJson(text);
}
