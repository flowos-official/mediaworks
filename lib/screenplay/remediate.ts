// lib/screenplay/remediate.ts
// Targeted compliance remediation engine (feature B). PURE w.r.t. the LLM: the
// section-rewrite model call is injected as `callLLM`, so the whole module is
// unit-testable with a fake. The workflow passes the real Gemini caller.
//
// Tier 1 — applyDeterministicPatches: string-replace offending spans that carry a
//   safe rewrite (lexicon safe_rewrite / LLM suggestedRewrite). No LLM.
// Tier 2 — remediateSections: for the remaining findings, regenerate ONLY the
//   affected act section(s) and splice them back; clean sections stay verbatim.

import type { Finding } from "./compliance/types";
import type { ProductBrief } from "./types";
import { splitSections, spliceSection, type Section } from "./sections";

export type LlmCall = (prompt: string) => Promise<string>;

export interface RemediateOpts {
  brief: ProductBrief;
  complianceBlock?: string;
  /** Reject a section rewrite shorter than this ratio of the original (guards
   *  against a truncated/empty model response). Default 0.3. */
  minSectionRatio?: number;
}

export interface RemediateResult {
  md: string;
  tier1Count: number;
  sectionsRewritten: number;
  unlocatable: number;
}

// ── Tier 1 ──────────────────────────────────────────────────────────────────
export function applyDeterministicPatches(
  md: string,
  findings: Finding[],
): { md: string; patched: Finding[]; remaining: Finding[] } {
  let out = md;
  const patched: Finding[] = [];
  const remaining: Finding[] = [];
  for (const fnd of findings) {
    const quote = (fnd.quote ?? "").trim();
    const rewrite = (fnd.suggestedRewrite ?? "").trim();
    // Need a usable rewrite + a precisely-locatable, non-trivial span. Skip
    // self-referential rewrites (rewrite contains the quote) to avoid re-flagging.
    if (quote.length < 3 || !rewrite || quote === rewrite || rewrite.includes(quote) || !out.includes(quote)) {
      remaining.push(fnd);
      continue;
    }
    out = out.split(quote).join(rewrite); // replace all occurrences
    patched.push(fnd);
  }
  return { md: out, patched, remaining };
}

// ── Locate findings to sections ──────────────────────────────────────────────
export function groupBySection(
  md: string,
  findings: Finding[],
): { groups: { section: Section; findings: Finding[] }[]; unlocatable: Finding[] } {
  const sections = splitSections(md);
  const byIdx = new Map<number, Finding[]>();
  const unlocatable: Finding[] = [];
  for (const fnd of findings) {
    const q = (fnd.quote ?? "").trim();
    const at = q.length > 0 ? md.indexOf(q) : -1;
    const idx = at === -1 ? -1 : sections.findIndex((s) => at >= s.start && at < s.end);
    if (idx === -1) {
      unlocatable.push(fnd);
      continue;
    }
    const arr = byIdx.get(idx) ?? [];
    arr.push(fnd);
    byIdx.set(idx, arr);
  }
  const groups = [...byIdx.entries()].map(([idx, fs]) => ({ section: sections[idx], findings: fs }));
  return { groups, unlocatable };
}

// ── Tier 2 ──────────────────────────────────────────────────────────────────
export function sectionRewritePrompt(section: Section, findings: Finding[], opts: RemediateOpts): string {
  const issues = findings
    .map((fnd, i) =>
      `${i + 1}. [${fnd.axis}/${fnd.severity}] 該当: 「${fnd.quote}」\n   理由: ${fnd.reason}${fnd.suggestedRewrite ? `\n   修正方針: ${fnd.suggestedRewrite}` : ""}`,
    )
    .join("\n");
  return [
    "あなたはテレビ通販の放送作家です。以下は台本の1セクションです。",
    "下記のコンプライアンス指摘を解消するよう、このセクションだけを書き直してください。",
    "",
    "【厳守】",
    "- 出力は完全に日本語のみ（英語禁止）。",
    "- このセクションの見出し・話者記法（[N]/[高橋]等）・演出キュー（[テロップ]等）・構成・おおよその長さを維持。",
    "- 指摘箇所のみを安全な表現に直し、それ以外は意味を保つ。",
    "- 出力はこのセクションのMarkdownのみ（前置き・後書き・コードフェンス禁止）。見出し行から始める。",
    opts.complianceBlock ? `\n${opts.complianceBlock}\n` : "",
    "【コンプライアンス指摘】",
    issues,
    "",
    "【現在のセクション】",
    section.text,
    "",
    "【出力】このセクションの修正版Markdownのみ。",
  ].join("\n");
}

export async function remediateSections(
  md: string,
  findings: Finding[],
  callLLM: LlmCall,
  opts: RemediateOpts,
): Promise<{ md: string; sectionsRewritten: number; unlocatable: number }> {
  const minRatio = opts.minSectionRatio ?? 0.3;
  const { groups, unlocatable } = groupBySection(md, findings);
  // Splice highest-offset section first so earlier sections' offsets stay valid.
  const ordered = [...groups].sort((a, b) => b.section.start - a.section.start);
  let out = md;
  let rewritten = 0;
  for (const g of ordered) {
    try {
      let text = (await callLLM(sectionRewritePrompt(g.section, g.findings, opts))).trim();
      const fence = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
      if (fence) text = fence[1].trim();
      if (!text || text.length < g.section.text.trim().length * minRatio) continue; // under-output → keep original
      const withNl = g.section.text.endsWith("\n") && !text.endsWith("\n") ? `${text}\n` : text;
      out = spliceSection(out, g.section, withNl);
      rewritten++;
    } catch {
      // keep the original section on any failure (non-fatal)
    }
  }
  return { md: out, sectionsRewritten: rewritten, unlocatable: unlocatable.length };
}

export async function remediate(
  md: string,
  findings: Finding[],
  callLLM: LlmCall,
  opts: RemediateOpts,
): Promise<RemediateResult> {
  const t1 = applyDeterministicPatches(md, findings);
  const t2 = await remediateSections(t1.md, t1.remaining, callLLM, opts);
  return { md: t2.md, tier1Count: t1.patched.length, sectionsRewritten: t2.sectionsRewritten, unlocatable: t2.unlocatable };
}
