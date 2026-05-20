// lib/screenplay/extract/from-excel.ts
import * as XLSX from "xlsx";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { EXTRACT_SYSTEM_INSTRUCTION, parseBriefJson } from "./brief-prompt";
import type { ProductBrief } from "../types";

const MODEL = "gemini-3-flash-preview";
const MAX_ROWS_PER_SHEET = 200;       // cap to keep prompt size bounded
const MAX_CELL_CHARS = 500;
const MAX_PROMPT_CHARS = 60_000;

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

interface SheetDump {
  sheetName: string;
  rows: string[][];
  truncated: boolean;
}

// Convert an unknown cell value into a short, safe string for the prompt.
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) + "…" : s;
}

export function dumpWorkbook(buffer: Buffer): SheetDump[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const out: SheetDump[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });
    const rows: string[][] = [];
    for (const row of aoa) {
      if (!Array.isArray(row)) continue;
      const mapped = row.map(cellToString);
      // Drop rows that are entirely empty after stringification.
      if (mapped.some((c) => c.length > 0)) rows.push(mapped);
    }
    out.push({
      sheetName,
      rows: rows.slice(0, MAX_ROWS_PER_SHEET),
      truncated: rows.length > MAX_ROWS_PER_SHEET,
    });
  }
  return out;
}

function buildPrompt(fileName: string, sheets: SheetDump[]): string {
  const blocks: string[] = [];
  blocks.push(`ファイル名: ${fileName}`);
  blocks.push("");
  blocks.push("以下は Excel ワークブックの内容を全シート分、行・列の二次元配列としてダンプしたものです。");
  blocks.push("レイアウトは固定ではないため、見出し行や項目ラベルを推測しながら ProductBrief を組み立ててください。");
  blocks.push("");
  for (const s of sheets) {
    blocks.push(`### Sheet: ${s.sheetName}${s.truncated ? "  (※先頭" + MAX_ROWS_PER_SHEET + "行のみ)" : ""}`);
    for (const row of s.rows) {
      blocks.push("- " + row.map((c) => c.replace(/\|/g, "/")).join(" | "));
    }
    blocks.push("");
  }
  let prompt = blocks.join("\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + "\n\n…(長すぎたため打ち切り)";
  }
  return prompt;
}

export async function extractBriefFromExcel(
  buffer: Buffer,
  fileName: string,
): Promise<ProductBrief> {
  const sheets = dumpWorkbook(buffer);
  if (sheets.length === 0 || sheets.every((s) => s.rows.length === 0)) {
    throw new Error("Excel ファイルから内容を読み取れませんでした");
  }
  const model = getGenAI().getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json" },
    systemInstruction: EXTRACT_SYSTEM_INSTRUCTION,
  });
  const userPrompt = buildPrompt(fileName, sheets);
  const result = await model.generateContent(userPrompt);
  return parseBriefJson(result.response.text());
}
