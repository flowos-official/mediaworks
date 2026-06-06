// lib/screenplay/compliance/context.ts
// Pure builder for the compliance block injected into the GENERATION prompt
// (feature A — prevention). No DB / no "server-only" — tsx-testable. The workflow
// loads active rules + references and calls this; prompt.ts injects the returned
// string into both initial and refine prompts. Empty corpus → "" (graceful no-op).

import type { ComplianceRule, ComplianceReference } from "./types";

const NG_CAP = Number(process.env.GEN_NG_CAP ?? "40") || 40;
const OK_CAP = 30;
const REF_CAP = Number(process.env.GEN_REF_CAP ?? "6") || 6;
const REF_BODY_CHARS = 300;

/** In scope when category_scope is empty (all categories) or includes category. */
function scoped(scope: string[], category: string | null): boolean {
  if (scope.length === 0) return true;
  if (!category) return false;
  return scope.includes(category);
}

export function buildGenerationComplianceBlock(
  category: string | null,
  rules: ComplianceRule[],
  references: ComplianceReference[],
): string {
  const ng = rules
    .filter((r) => r.active && !r.allowed && scoped(r.category_scope, category))
    .slice(0, NG_CAP)
    .map((r) => `- [${r.law}] ${r.pattern}（${r.reason}）`);
  const ok = rules
    .filter((r) => r.active && r.allowed && scoped(r.category_scope, category))
    .slice(0, OK_CAP)
    .map((r) => `- ${r.pattern}`);
  const refs = references
    .filter((r) => r.active && scoped(r.category_scope, category))
    .slice(0, REF_CAP)
    .map((r) => `- 【${r.topic}】${r.body.slice(0, REF_BODY_CHARS)}（出典: ${r.citation || r.law}）`);

  if (ng.length === 0 && ok.length === 0 && refs.length === 0) return "";

  const parts: string[] = [
    "## コンプライアンス遵守ルール（生成時に厳守）",
    "以下のNG表現を避け、許容表現・根拠資料の範囲を超える効能・優良誤認・根拠なき最上級表現を書かないこと。",
  ];
  if (ng.length) parts.push("", "### 禁止表現（使用しない）", ng.join("\n"));
  if (ok.length) parts.push("", "### 許容表現（これは問題ない）", ok.join("\n"));
  if (refs.length) parts.push("", "### 根拠資料（カテゴリ基準）", refs.join("\n"));
  return parts.join("\n");
}
