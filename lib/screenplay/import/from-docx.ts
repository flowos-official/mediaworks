// lib/screenplay/import/from-docx.ts
// .docx → text via mammoth. No "server-only" — importable from tsx smoke scripts.
//
// Default path uses extractRawText. Our DOCX export lays speaker lines out as
// borderless 2-column tables; extractRawText still emits each cell's text, which
// the LLM normalizer re-tags. If the round-trip gate in scripts/test-screenplay-import.ts
// ever shows degraded recovery, switch this to mammoth.convertToHtml (HTML keeps
// <table>/<tr>/<td> boundaries) and return { text: html, format: "html" } —
// IMPORT_SYSTEM_INSTRUCTION already accepts HTML input.
import mammoth from "mammoth";

export interface DocxExtractResult {
  text: string;
  format: "text" | "html";
}

export async function extractDocxText(buffer: Buffer): Promise<DocxExtractResult> {
  let value: string;
  try {
    const result = await mammoth.extractRawText({ buffer });
    value = (result.value ?? "").trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Word ファイルを解析できませんでした: ${msg}`);
  }
  if (!value) throw new Error("Word ファイルからテキストを抽出できませんでした（空の可能性があります）");
  return { text: value, format: "text" };
}
