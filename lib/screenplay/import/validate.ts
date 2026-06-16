// lib/screenplay/import/validate.ts
// DB-free guard for operator-reviewed imported markdown re-sent to POST /api/screenplays.
// No "server-only" — importable from tsx smoke scripts.
import { IMPORT_MARKDOWN_MAX } from "./constants";

const HEADING_RE = /^\s*#{1,3}\s+\S/m;
const TAG_RE = /^\s*\[[^\]]+\]/m;

export interface ImportedMarkdownValidation {
  ok: boolean;
  error?: string;
  markdown?: string;
}

export function validateImportedMarkdown(input: unknown): ImportedMarkdownValidation {
  if (typeof input !== "string") return { ok: false, error: "importedMarkdown は文字列で指定してください" };
  const md = input.trim();
  if (!md) return { ok: false, error: "台本本文が空です" };
  if (md.length > IMPORT_MARKDOWN_MAX) {
    return { ok: false, error: `台本が長すぎます（最大 ${IMPORT_MARKDOWN_MAX.toLocaleString()} 文字）` };
  }
  const nonEmptyLines = md.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  const hasStructure = HEADING_RE.test(md) || TAG_RE.test(md) || nonEmptyLines >= 8;
  if (!hasStructure) {
    return { ok: false, error: "台本の構造を認識できません（見出し・話者タグ・十分な行数のいずれも見つかりません）" };
  }
  return { ok: true, markdown: md };
}
