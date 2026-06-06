# Screenplay Compliance Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make compliance rules feed the screenplay GENERATOR (A: prevention) and add a hybrid, targeted auto-remediation loop after generation (B: deterministic patch → per-act section regeneration), so the model knows the rules upfront and high-severity violations are fixed without full-document regeneration.

**Architecture:** Feature A loads category-scoped `compliance_rules`/`compliance_references` and injects a Japanese block into `prompt.ts` (both initial+refine). Feature B runs a corpus-only check after generation; on a high-severity violation it applies Tier1 deterministic string patches then Tier2 per-act section rewrites (LLM via dependency injection), re-checks, up to 3 iterations. All remediation is non-fatal. Spec: `docs/superpowers/specs/2026-06-06-screenplay-compliance-integration-design.md`.

**Tech Stack:** TypeScript, Next.js App Router, Vercel Workflow (`"use step"`), `@google/genai` (Gemini Flash-first + Pro fallback), Supabase, tsx for unit tests.

---

## File Structure

**New (pure, tsx-testable):**
- `lib/screenplay/sections.ts` — split markdown into `##`/`###` sections (round-trip invariant) + splice.
- `lib/screenplay/compliance/context.ts` — `buildGenerationComplianceBlock` (A: generation prompt block).
- `lib/screenplay/compliance/triggers.ts` — `hasHighViolation` / `remediableFindings` / `countHigh` (B: trigger).
- `lib/screenplay/remediate.ts` — Tier1 `applyDeterministicPatches`, `groupBySection`, `sectionRewritePrompt`, Tier2 `remediateSections`, `remediate` (LLM via injected `callLLM`).

**Modified:**
- `lib/screenplay/compliance/types.ts` — `RemediationStep`/`RemediationMeta`, `ScriptCheckResult.remediation?`.
- `lib/screenplay/types.ts` — `GenerateInput.complianceBlock?`.
- `lib/screenplay/prompt.ts` — inject `complianceBlock` (both modes).
- `lib/screenplay/compliance/check.ts` — `export` `callGemini`.
- `lib/workflows/screenplay.workflow.ts` — load compliance, inject block, remediation loop, persist trail; restructure order.
- `.env.example`, `package.json` (test aliases).

**New tests:** `scripts/test-screenplay-sections.ts`, `scripts/test-compliance-context.ts`, `scripts/test-screenplay-prompt.ts`, `scripts/test-compliance-triggers.ts`, `scripts/test-screenplay-remediate.ts`.

---

## Task 1: Section splitter/splicer (`lib/screenplay/sections.ts`)

**Files:**
- Create: `lib/screenplay/sections.ts`
- Test: `scripts/test-screenplay-sections.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-screenplay-sections.ts`:

```ts
/**
 * Unit test for the pure screenplay section splitter/splicer. No DB / no network.
 * Run: npm run test:screenplay-sections
 */
import assert from "node:assert";
import { splitSections, spliceSection } from "../lib/screenplay/sections";

const MD = [
  "# 商品 — 台本",
  "",
  "## メタ情報",
  "- 商品名: X",
  "",
  "## 本編",
  "",
  "### ■アバン",
  "[N] (明るく)",
  "セリフA",
  "",
  "### ■スタジオ①",
  "セリフB",
  "",
].join("\n");

// round-trip invariant: concatenating every section's verbatim text === source
const secs = splitSections(MD);
assert.strictEqual(secs.map((s) => s.text).join(""), MD, "round-trip invariant");

// prologue is the text before the first heading (here the H1 title line)
assert.strictEqual(secs[0].level, 0, "first section is the level-0 prologue");
assert.ok(secs[0].text.includes("# 商品 — 台本"), "prologue holds H1 title");

// boundaries detected at ## and ###
const headings = secs.map((s) => s.heading);
assert.ok(headings.includes("## メタ情報"), "## boundary");
assert.ok(headings.includes("### ■アバン"), "### boundary");
assert.ok(headings.includes("### ■スタジオ①"), "second ### boundary");

// splice replaces ONLY the target section, others verbatim
const aban = secs.find((s) => s.heading === "### ■アバン");
assert.ok(aban, "found ■アバン");
const out = spliceSection(MD, aban, "### ■アバン\nセリフA-修正\n\n");
assert.ok(out.includes("セリフA-修正"), "new text present");
assert.ok(out.includes("セリフB"), "sibling section untouched");
assert.ok(out.includes("## メタ情報"), "earlier section untouched");
assert.ok(!/セリフA\n/.test(out), "old line replaced");

// empty input does not throw and round-trips
assert.strictEqual(splitSections("").map((s) => s.text).join(""), "", "empty round-trip");

console.log("[test:screenplay-sections] PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-screenplay-sections.ts`
Expected: FAIL — `Cannot find module '../lib/screenplay/sections'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/screenplay/sections.ts`:

```ts
// lib/screenplay/sections.ts
// Pure screenplay-section splitter/splicer. No DB / no "server-only" — importable
// from tsx smoke scripts. Splits markdown on top-level (##) and act-level (###)
// headings, preserving every character so split→join === original (round-trip
// invariant). Used by the targeted remediation engine to regenerate only the
// affected act and splice it back, leaving clean sections byte-for-byte intact.

export interface Section {
  /** The heading line without its trailing newline, or "" for the prologue. */
  heading: string;
  /** 2 = `## `, 3 = `### `, 0 = prologue (text before the first heading). */
  level: 2 | 3 | 0;
  /** Verbatim slice INCLUDING the heading line and everything up to the next
   *  boundary (trailing blank lines included). */
  text: string;
  /** Char offset of this section's start in the source markdown. */
  start: number;
  /** Char offset (exclusive) of this section's end. */
  end: number;
}

const BOUNDARY = /^(#{2,3})\s+.*$/;

export function splitSections(md: string): Section[] {
  // Split keeping the newline terminator on each element (lookbehind).
  const lines = md.split(/(?<=\n)/);
  const sections: Section[] = [];
  let cur: { heading: string; level: 2 | 3 | 0; start: number; buf: string } | null = null;
  let offset = 0;

  const flush = (endOffset: number) => {
    if (cur) sections.push({ heading: cur.heading, level: cur.level, text: cur.buf, start: cur.start, end: endOffset });
  };

  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    const m = bare.match(BOUNDARY);
    if (m) {
      flush(offset);
      const level = (m[1].length === 2 ? 2 : 3) as 2 | 3;
      cur = { heading: bare, level, start: offset, buf: line };
    } else if (cur) {
      cur.buf += line;
    } else {
      cur = { heading: "", level: 0, start: offset, buf: line };
    }
    offset += line.length;
  }
  flush(offset);
  return sections;
}

export function spliceSection(md: string, section: Section, newText: string): string {
  return md.slice(0, section.start) + newText + md.slice(section.end);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-screenplay-sections.ts`
Expected: `[test:screenplay-sections] PASS`

- [ ] **Step 5: Commit**

```bash
git add lib/screenplay/sections.ts scripts/test-screenplay-sections.ts
git commit -m "feat(screenplay): pure section splitter/splicer for targeted remediation"
```

---

## Task 2: Generation compliance block (`lib/screenplay/compliance/context.ts`)

**Files:**
- Create: `lib/screenplay/compliance/context.ts`
- Test: `scripts/test-compliance-context.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-context.ts`:

```ts
/**
 * Unit test for the generation compliance block builder (feature A). Pure.
 * Run: npm run test:compliance-context
 */
import assert from "node:assert";
import { buildGenerationComplianceBlock } from "../lib/screenplay/compliance/context";
import type { ComplianceRule, ComplianceReference } from "../lib/screenplay/compliance/types";

const rule = (o: Partial<ComplianceRule>): ComplianceRule => ({
  id: "x", law: "yakkiho", category_scope: [], pattern: "p", is_regex: false,
  allowed: false, severity: "high", reason: "r", safe_rewrite: "", citation: "", active: true, ...o,
});
const ref = (o: Partial<ComplianceReference>): ComplianceReference => ({
  id: "x", law: "yakkiho", category_scope: [], topic: "t", body: "b", keywords: [],
  citation: "c", source_url: "", active: true, ...o,
});

// empty corpus → no-op (empty string)
assert.strictEqual(buildGenerationComplianceBlock(null, [], []), "", "empty → no-op");

// NG + allowed + ref render
const block = buildGenerationComplianceBlock("化粧品", [
  rule({ pattern: "シミが消える", reason: "効能逸脱" }),
  rule({ pattern: "乾燥による小じわを目立たなくする", allowed: true }),
], [ref({ topic: "56効能", body: "範囲内のみ可", category_scope: ["化粧品"] })]);
assert.ok(block.includes("禁止表現"), "has NG section");
assert.ok(block.includes("シミが消える"), "NG pattern rendered");
assert.ok(block.includes("許容表現"), "has allowed section");
assert.ok(block.includes("根拠資料"), "has reference section");
assert.ok(block.includes("56効能"), "reference topic rendered");

// category scoping: a 食品-scoped rule must NOT appear for 化粧品
assert.strictEqual(
  buildGenerationComplianceBlock("化粧品", [rule({ pattern: "痩せる", category_scope: ["食品"] })], []),
  "", "out-of-scope rule excluded → empty",
);

// inactive excluded
assert.strictEqual(buildGenerationComplianceBlock(null, [rule({ active: false })], []), "", "inactive excluded");

// empty-scope rule applies to all categories
assert.ok(
  buildGenerationComplianceBlock("食品", [rule({ pattern: "絶対安全", category_scope: [] })], []).includes("絶対安全"),
  "empty scope = all categories",
);

console.log("[test:compliance-context] PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-compliance-context.ts`
Expected: FAIL — `Cannot find module '../lib/screenplay/compliance/context'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/screenplay/compliance/context.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-compliance-context.ts`
Expected: `[test:compliance-context] PASS`

- [ ] **Step 5: Commit**

```bash
git add lib/screenplay/compliance/context.ts scripts/test-compliance-context.ts
git commit -m "feat(screenplay): category-scoped compliance block builder for generation prompt (A)"
```

---

## Task 3: Inject compliance block into the generation prompt (`types.ts`, `prompt.ts`)

**Files:**
- Modify: `lib/screenplay/types.ts` (add `complianceBlock?` to `GenerateInput`)
- Modify: `lib/screenplay/prompt.ts` (inject in both modes)
- Test: `scripts/test-screenplay-prompt.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-screenplay-prompt.ts`:

```ts
/**
 * Unit test: buildUserPrompt injects complianceBlock in both modes. Reads
 * style-bible from disk (cwd = repo root); no DB / no network.
 * Run: npm run test:screenplay-prompt
 */
import assert from "node:assert";
import { buildUserPrompt } from "../lib/screenplay/prompt";
import type { GenerateInput } from "../lib/screenplay/types";

const brief = { name: "テスト商品", description: "説明文" };
const BLOCK = "## コンプライアンス遵守ルール（生成時に厳守）\n### 禁止表現（使用しない）\n- [yakkiho] シミが消える（効能逸脱）";

const initial = await buildUserPrompt({ mode: "initial", productBrief: brief, complianceBlock: BLOCK });
assert.ok(initial.includes("必須遵守"), "initial: 必須遵守 marker present");
assert.ok(initial.includes("コンプライアンス遵守ルール"), "initial: block injected");

const refine = await buildUserPrompt({
  mode: "refine", productBrief: brief, feedback: "もっと明るく",
  previousMarkdown: "# 旧台本\n## 本編\n[N] こんにちは。",
  complianceBlock: BLOCK,
} as GenerateInput);
assert.ok(refine.includes("必須遵守"), "refine: 必須遵守 marker present");
assert.ok(refine.includes("コンプライアンス遵守ルール"), "refine: block injected");

const without = await buildUserPrompt({ mode: "initial", productBrief: brief });
assert.ok(!without.includes("必須遵守"), "no marker when block absent");

console.log("[test:screenplay-prompt] PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-screenplay-prompt.ts`
Expected: FAIL — assertion "initial: 必須遵守 marker present" (block not yet injected).

- [ ] **Step 3a: Add the field to `GenerateInput`**

In `lib/screenplay/types.ts`, change the `GenerateInput` interface:

```ts
export interface GenerateInput {
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;
  previousMarkdown?: string;
  /** Pre-built compliance block (feature A) injected verbatim into the prompt.
   *  Empty/undefined → not injected. Built by buildGenerationComplianceBlock. */
  complianceBlock?: string;
}
```

- [ ] **Step 3b: Inject in the INITIAL branch of `buildUserPrompt`**

In `lib/screenplay/prompt.ts`, inside `if (input.mode === "initial")`, AFTER the `if (customBlock) parts.push(...)` line and BEFORE the `parts.push("", "---", "", "## style_bible 抜粋...")` call, insert:

```ts
		const complianceInitial = input.complianceBlock?.trim();
		if (complianceInitial) parts.push("", "---", "", "--- 必須遵守 ---", "", complianceInitial);
```

- [ ] **Step 3c: Inject in the REFINE branch of `buildUserPrompt`**

In the refine branch, AFTER `if (customBlock) parts.push("", "---", "", customBlock);` and BEFORE the `parts.push("", "---", "", "## style_bible 抜粋...")` call, insert:

```ts
	const complianceRefine = input.complianceBlock?.trim();
	if (complianceRefine) parts.push("", "---", "", "--- 必須遵守 ---", "", complianceRefine);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-screenplay-prompt.ts`
Expected: `[test:screenplay-prompt] PASS`

- [ ] **Step 5: Commit**

```bash
git add lib/screenplay/types.ts lib/screenplay/prompt.ts scripts/test-screenplay-prompt.ts
git commit -m "feat(screenplay): inject compliance block into initial+refine generation prompts (A)"
```

---

## Task 4: Remediation trigger helpers (`lib/screenplay/compliance/triggers.ts`)

**Files:**
- Create: `lib/screenplay/compliance/triggers.ts`
- Test: `scripts/test-compliance-triggers.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-triggers.ts`:

```ts
/**
 * Unit test for remediation trigger helpers. Pure (no DB import chain).
 * Run: npm run test:compliance-triggers
 */
import assert from "node:assert";
import { hasHighViolation, remediableFindings, countHigh } from "../lib/screenplay/compliance/triggers";
import type { Finding, ScriptCheckResult } from "../lib/screenplay/compliance/types";

const f = (o: Partial<Finding>): Finding => ({
  axis: "legal", severity: "low", quote: "q", reason: "r", citedRule: "", suggestedRewrite: "", source: "llm", ...o,
});
const result = (o: Partial<ScriptCheckResult>): ScriptCheckResult => ({
  overallScore: 100, legal: [], facts: [], quality: [], ...o,
});

assert.strictEqual(hasHighViolation(result({})), false, "no findings → false");
assert.strictEqual(hasHighViolation(result({ legal: [f({ severity: "high" })] })), true, "legal high → true");
assert.strictEqual(hasHighViolation(result({ facts: [f({ axis: "facts", severity: "high" })] })), true, "facts high → true");
assert.strictEqual(hasHighViolation(result({ legal: [f({ source: "lexicon", severity: "low" })] })), true, "lexicon any severity → true");
assert.strictEqual(hasHighViolation(result({ quality: [f({ axis: "quality", severity: "high" })] })), false, "quality never triggers");

assert.strictEqual(
  remediableFindings(result({ legal: [f({})], facts: [f({ axis: "facts" })], quality: [f({ axis: "quality" })] })).length,
  2, "remediable = legal + facts only",
);
assert.strictEqual(countHigh(result({ legal: [f({ severity: "high" }), f({ source: "lexicon" })], facts: [f({})] })), 2, "countHigh");

console.log("[test:compliance-triggers] PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-compliance-triggers.ts`
Expected: FAIL — `Cannot find module '../lib/screenplay/compliance/triggers'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/screenplay/compliance/triggers.ts`:

```ts
// lib/screenplay/compliance/triggers.ts
// Pure predicates that drive the auto-remediation loop. Importing this never
// pulls the DB/Gemini chain (only ./types), so it stays unit-testable and cheap.

import type { Finding, ScriptCheckResult } from "./types";

/** A finding worth auto-remediating: any legal/facts finding at "high" severity,
 *  OR any deterministic lexicon NG (rule-certain regardless of severity). Quality
 *  findings (structural advisories) never trigger. */
function isRemediable(f: Finding): boolean {
  return f.severity === "high" || f.source === "lexicon";
}

export function remediableFindings(result: ScriptCheckResult): Finding[] {
  return [...result.legal, ...result.facts];
}

export function hasHighViolation(result: ScriptCheckResult): boolean {
  return remediableFindings(result).some(isRemediable);
}

export function countHigh(result: ScriptCheckResult): number {
  return remediableFindings(result).filter(isRemediable).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-compliance-triggers.ts`
Expected: `[test:compliance-triggers] PASS`

- [ ] **Step 5: Commit**

```bash
git add lib/screenplay/compliance/triggers.ts scripts/test-compliance-triggers.ts
git commit -m "feat(screenplay): remediation trigger predicates (high + lexicon, quality excluded)"
```

---

## Task 5: Tier1 deterministic patch + section grouping (`lib/screenplay/remediate.ts`)

**Files:**
- Create: `lib/screenplay/remediate.ts`
- Test: `scripts/test-screenplay-remediate.ts`

- [ ] **Step 1: Write the failing test (Tier1 + grouping)**

Create `scripts/test-screenplay-remediate.ts`:

```ts
/**
 * Unit test for the remediation engine. Tier1 + grouping are pure; Tier2 is
 * exercised with a FAKE callLLM (no Gemini). No DB / no network.
 * Run: npm run test:screenplay-remediate
 */
import assert from "node:assert";
import { applyDeterministicPatches, groupBySection, remediateSections, remediate } from "../lib/screenplay/remediate";
import type { Finding } from "../lib/screenplay/compliance/types";

const f = (o: Partial<Finding>): Finding => ({
  axis: "legal", severity: "high", quote: "q", reason: "r", citedRule: "", suggestedRewrite: "", source: "llm", ...o,
});

// --- Tier1: deterministic patch ---
{
  const md = "[N] シミが消える、業界初の技術。";
  const findings = [
    f({ quote: "シミが消える", suggestedRewrite: "うるおいを与える", source: "lexicon" }),
    f({ quote: "業界初", suggestedRewrite: "", severity: "med", source: "lexicon" }), // no rewrite → remaining
    f({ quote: "に", suggestedRewrite: "へ" }), // quote < 3 chars → skip
  ];
  const r = applyDeterministicPatches(md, findings);
  assert.ok(r.md.includes("うるおいを与える"), "rewrite applied");
  assert.ok(!r.md.includes("シミが消える"), "offending span gone");
  assert.strictEqual(r.patched.length, 1, "1 patched");
  assert.strictEqual(r.remaining.length, 2, "2 remaining (no-rewrite + short)");
}

// Tier1 skips self-referential rewrite (rewrite contains quote)
{
  const r = applyDeterministicPatches("絶対安全です", [f({ quote: "絶対安全", suggestedRewrite: "ほぼ絶対安全" })]);
  assert.strictEqual(r.patched.length, 0, "self-referential rewrite skipped");
  assert.ok(r.md.includes("絶対安全です"), "unchanged");
}

// --- grouping by section ---
{
  const md = ["## 本編", "", "### ■アバン", "[N] シミが消える！", "", "### ■CTA", "[N] お電話を！", ""].join("\n");
  const { groups, unlocatable } = groupBySection(md, [f({ quote: "シミが消える" }), f({ quote: "存在しない文言" })]);
  assert.strictEqual(groups.length, 1, "one affected section");
  assert.strictEqual(groups[0].section.heading, "### ■アバン", "located to ■アバン");
  assert.strictEqual(unlocatable.length, 1, "missing quote is unlocatable");
}

// --- Tier2 with fake LLM: only affected section rewritten, siblings verbatim ---
{
  const md = ["## 本編", "", "### ■アバン", "[N] シミが消える！", "", "### ■CTA", "[N] お電話を！", ""].join("\n");
  const findings = [f({ quote: "シミが消える", reason: "効能逸脱" })];
  const fakeLLM = async () => "### ■アバン\n[N] うるおいを与える！\n";
  const r = await remediateSections(md, findings, fakeLLM, { brief: { name: "x", description: "d" } });
  assert.strictEqual(r.sectionsRewritten, 1, "one section rewritten");
  assert.ok(r.md.includes("うるおいを与える"), "rewrite spliced in");
  assert.ok(!r.md.includes("シミが消える"), "offending text gone");
  assert.ok(r.md.includes("### ■CTA") && r.md.includes("お電話を"), "sibling section intact");
}

// Tier2 under-output guard: keep original when LLM returns too-short text
{
  const md = ["### ■アバン", "とても長い本文がここにたくさん続きます。".repeat(5), ""].join("\n");
  const findings = [f({ quote: "長い本文" })];
  const r = await remediateSections(md, findings, async () => "短い", { brief: { name: "x", description: "d" } });
  assert.strictEqual(r.sectionsRewritten, 0, "too-short rewrite rejected");
  assert.ok(r.md.includes("長い本文"), "original kept");
}

// --- remediate orchestrator: Tier1 handles rewritable, Tier2 handles the rest ---
{
  const md = ["### ■アバン", "[N] シミが消える！ そして最強です。", ""].join("\n");
  const findings = [
    f({ quote: "シミが消える", suggestedRewrite: "うるおいを与える", source: "lexicon" }), // Tier1
    f({ quote: "最強", suggestedRewrite: "", source: "lexicon" }),                          // Tier2
  ];
  const fakeLLM = async () => "### ■アバン\n[N] うるおいを与える！ そして高評価です。\n";
  const out = await remediate(md, findings, fakeLLM, { brief: { name: "x", description: "d" } });
  assert.strictEqual(out.tier1Count, 1, "1 deterministic patch");
  assert.strictEqual(out.sectionsRewritten, 1, "1 section rewrite for the remainder");
  assert.ok(!out.md.includes("最強"), "remainder fixed by Tier2");
}

console.log("[test:screenplay-remediate] PASS");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-screenplay-remediate.ts`
Expected: FAIL — `Cannot find module '../lib/screenplay/remediate'`.

- [ ] **Step 3: Write the implementation**

Create `lib/screenplay/remediate.ts`:

```ts
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
    const at = q.length >= 3 ? md.indexOf(q) : -1;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-screenplay-remediate.ts`
Expected: `[test:screenplay-remediate] PASS`

- [ ] **Step 5: Commit**

```bash
git add lib/screenplay/remediate.ts scripts/test-screenplay-remediate.ts
git commit -m "feat(screenplay): hybrid remediation engine — Tier1 patch + Tier2 section rewrite (DI LLM)"
```

---

## Task 6: Compliance result types for the remediation trail (`compliance/types.ts`)

**Files:**
- Modify: `lib/screenplay/compliance/types.ts`

- [ ] **Step 1: Add the trail types**

Append to `lib/screenplay/compliance/types.ts` (after the `GroundingMeta` interface):

```ts
/** One auto-remediation iteration's bookkeeping (feature B). */
export interface RemediationStep {
  iter: number;
  tier1: number;        // deterministic patches applied
  sections: number;     // act sections regenerated
  unlocatable: number;  // findings whose quote could not be located
  scoreBefore: number;
  scoreAfter: number;
  residualHigh: number; // remediable findings still present after this iter
}

export interface RemediationMeta {
  enabled: boolean;
  iterations: RemediationStep[];
  finalHigh: number;
}
```

- [ ] **Step 2: Add `remediation?` to `ScriptCheckResult`**

In the same file, change the `ScriptCheckResult` interface to add the optional field:

```ts
export interface ScriptCheckResult {
  overallScore: number;    // 0..100
  legal: Finding[];
  facts: Finding[];
  quality: Finding[];
  grounding?: GroundingMeta;
  remediation?: RemediationMeta; // present on auto-checks that ran the loop (B)
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (the new fields are additive/optional).

- [ ] **Step 4: Commit**

```bash
git add lib/screenplay/compliance/types.ts
git commit -m "feat(screenplay): remediation trail types on ScriptCheckResult"
```

---

## Task 7: Export the Gemini caller for reuse (`compliance/check.ts`)

**Files:**
- Modify: `lib/screenplay/compliance/check.ts`

- [ ] **Step 1: Export `callGemini`**

In `lib/screenplay/compliance/check.ts`, change the declaration:

```ts
async function callGemini(prompt: string): Promise<string> {
```

to:

```ts
export async function callGemini(prompt: string): Promise<string> {
```

(No other change — it already streams Flash-first with Pro fallback, a 60s/30s timeout, which is suited to the small per-section rewrite.)

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/screenplay/compliance/check.ts
git commit -m "refactor(screenplay): export callGemini for section-rewrite reuse"
```

---

## Task 8: Wire A + B into the workflow (`lib/workflows/screenplay.workflow.ts`)

**Files:**
- Modify: `lib/workflows/screenplay.workflow.ts`

This restructures the workflow so the check drives a remediation loop BEFORE the final persist. `generateStep` gains the compliance block; `checkStep` becomes `persistCheckStep` (persists the already-computed final check + trail).

- [ ] **Step 1: Update imports**

Replace the existing import block at the top of `lib/workflows/screenplay.workflow.ts` (lines importing from `@/lib/screenplay/...`) so it reads:

```ts
import { getWritable, FatalError } from "workflow";
import { generateScreenplay } from "@/lib/screenplay/generator";
import { getServiceClient } from "@/lib/supabase";
import type {
  GenerationMode,
  ProductBrief,
  ProgressEvent,
  ScreenplayVersionRow,
} from "@/lib/screenplay/types";
import {
  loadActiveRules,
  loadActiveReferences,
  checkScreenplay,
  callGemini,
} from "@/lib/screenplay/compliance/check";
import { buildGenerationComplianceBlock } from "@/lib/screenplay/compliance/context";
import { hasHighViolation, remediableFindings, countHigh } from "@/lib/screenplay/compliance/triggers";
import { remediate } from "@/lib/screenplay/remediate";
import type {
  ComplianceRule,
  ComplianceReference,
  ScriptCheckResult,
  RemediationStep,
} from "@/lib/screenplay/compliance/types";
```

- [ ] **Step 2: Add config constants + compliance-load step**

After the `ScreenplayWorkflowInput` interface, add:

```ts
const AUTO_REMEDIATE = process.env.SCREENPLAY_AUTO_REMEDIATE !== "false";
const MAX_REMEDIATE_ITERS = Number(process.env.MAX_REMEDIATE_ITERS ?? "3") || 3;

async function loadComplianceStep(): Promise<{ rules: ComplianceRule[]; references: ComplianceReference[] }> {
  "use step";
  const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
  return { rules, references };
}
```

- [ ] **Step 3: Give `generateStep` the compliance block**

Change the `generateStep` signature and the `generateScreenplay` call. Replace the whole `generateStep` function with:

```ts
async function generateStep(
  input: ScreenplayWorkflowInput,
  previousMarkdown: string | undefined,
  complianceBlock: string,
): Promise<{ markdown: string; model: string; thinkingLevel: string }> {
  "use step";
  await writeProgressInline({ type: "step", name: "generate", status: "started" });
  try {
    const result = await generateScreenplay(
      {
        mode: input.mode,
        productBrief: input.productBrief,
        feedback: input.feedback,
        previousMarkdown,
        complianceBlock,
      },
      (chars) => { void writeProgressInline({ type: "chunk", chars }); },
    );
    await writeProgressInline({ type: "step", name: "generate", status: "completed" });
    return { markdown: result.markdown, model: result.model, thinkingLevel: result.thinkingLevel };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeProgressInline({ type: "step", name: "generate", status: "failed", detail: msg });
    throw err;
  }
}
```

- [ ] **Step 4: Replace `checkStep` with the remediation loop + persist-check steps**

Delete the existing `checkStep` function and add these two functions in its place:

```ts
async function safeCheck(
  md: string,
  brief: ProductBrief,
  rules: ComplianceRule[],
  references: ComplianceReference[],
): Promise<ScriptCheckResult | null> {
  // Corpus-only (no factSearch) — unreleased copy never leaves the boundary (Codex #1).
  try {
    return await checkScreenplay(md, brief, rules, references);
  } catch (err) {
    console.warn("[remediate] check failed (non-fatal):", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function remediateLoopStep(
  markdown: string,
  brief: ProductBrief,
  rules: ComplianceRule[],
  references: ComplianceReference[],
  complianceBlock: string,
): Promise<{ markdown: string; check: ScriptCheckResult | null; trail: RemediationStep[] }> {
  "use step";
  let md = markdown;
  let check = await safeCheck(md, brief, rules, references);
  const trail: RemediationStep[] = [];
  if (AUTO_REMEDIATE && check) {
    let iter = 0;
    while (hasHighViolation(check) && iter < MAX_REMEDIATE_ITERS) {
      const before = check.overallScore;
      let r;
      try {
        r = await remediate(md, remediableFindings(check), callGemini, { brief, complianceBlock });
      } catch (err) {
        console.warn("[remediate] iteration failed (non-fatal):", err instanceof Error ? err.message : String(err));
        break;
      }
      md = r.md;
      const next = await safeCheck(md, brief, rules, references);
      if (!next) break;
      check = next;
      trail.push({
        iter,
        tier1: r.tier1Count,
        sections: r.sectionsRewritten,
        unlocatable: r.unlocatable,
        scoreBefore: before,
        scoreAfter: check.overallScore,
        residualHigh: countHigh(check),
      });
      iter++;
    }
  }
  return { markdown: md, check, trail };
}

async function persistCheckStep(
  versionId: string,
  check: ScriptCheckResult | null,
  trail: RemediationStep[],
  rulesLen: number,
  refsLen: number,
): Promise<void> {
  "use step";
  // Non-fatal: a failed persist must NEVER fail the generation.
  if (!check) return;
  try {
    const supabase = getServiceClient();
    const result: ScriptCheckResult = {
      ...check,
      remediation: { enabled: AUTO_REMEDIATE, iterations: trail, finalHigh: countHigh(check) },
    };
    await supabase.from("screenplay_version_checks").insert({
      version_id: versionId,
      overall_score: check.overallScore,
      result,
      lexicon_version: `rules:${rulesLen} refs:${refsLen} h:${check.grounding?.corpusHash ?? ""}`,
      is_auto: true,
      created_by: null,
    });
  } catch (err) {
    console.warn("[persistCheckStep] failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 5: Rewrite the workflow body**

Replace the body of `screenplayWorkflow` (the `try { ... }` block, keeping the outer `try/catch` and `"use workflow"`):

```ts
export async function screenplayWorkflow(input: ScreenplayWorkflowInput) {
  "use workflow";

  try {
    let previousMarkdown: string | undefined;
    if (input.mode === "refine") {
      if (!input.baseVersionId) throw new FatalError("refine mode requires baseVersionId");
      previousMarkdown = await loadPreviousMarkdownStep(input.baseVersionId);
    }

    const { rules, references } = await loadComplianceStep();
    const complianceBlock = buildGenerationComplianceBlock(
      input.productBrief.category ?? null,
      rules,
      references,
    );

    const gen = await generateStep(input, previousMarkdown, complianceBlock);

    const { markdown, check, trail } = await remediateLoopStep(
      gen.markdown,
      input.productBrief,
      rules,
      references,
      complianceBlock,
    );

    const persisted = await persistStep(
      input.screenplayId,
      markdown,
      input.feedback,
      input.baseVersionId,
      gen.model,
      gen.thinkingLevel,
    );

    await persistCheckStep(persisted.versionId, check, trail, rules.length, references.length);

    await emitProgressStep({
      type: "done",
      screenplayId: input.screenplayId,
      versionId: persisted.versionId,
      versionNumber: persisted.versionNumber,
    });
    return { screenplayId: input.screenplayId, ...persisted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailedStep(input.screenplayId, msg);
    throw err;
  }
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (If `r` triggers "used before assigned", confirm the `let r;` + `break` on catch is intact — `r` is only read after the successful assignment.)

- [ ] **Step 7: Commit**

```bash
git add lib/workflows/screenplay.workflow.ts
git commit -m "feat(screenplay): wire compliance block (A) + targeted auto-remediation loop (B) into workflow"
```

---

## Task 9: Env, package scripts, and full verification

**Files:**
- Modify: `.env.example`, `package.json`

- [ ] **Step 1: Document env flags**

Append to `.env.example`:

```bash
# Screenplay compliance auto-remediation (feature B). "false" disables the loop;
# generation-time rule injection (A) is always on. Optional tuning below.
SCREENPLAY_AUTO_REMEDIATE=true
MAX_REMEDIATE_ITERS=3
GEN_NG_CAP=40
GEN_REF_CAP=6
```

- [ ] **Step 2: Add test aliases**

In `package.json` `scripts`, add (next to the other `test:screenplay-*` / `test:compliance-*` entries):

```json
    "test:screenplay-sections": "tsx scripts/test-screenplay-sections.ts",
    "test:screenplay-prompt": "tsx scripts/test-screenplay-prompt.ts",
    "test:compliance-context": "tsx scripts/test-compliance-context.ts",
    "test:compliance-triggers": "tsx scripts/test-compliance-triggers.ts",
    "test:screenplay-remediate": "tsx scripts/test-screenplay-remediate.ts",
```

- [ ] **Step 3: Run all new unit tests + type-check**

Run:
```bash
npx tsc --noEmit
npm run test:screenplay-sections
npm run test:compliance-context
npm run test:screenplay-prompt
npm run test:compliance-triggers
npm run test:screenplay-remediate
```
Expected: `tsc` clean; every test prints `PASS` / assertion count.

- [ ] **Step 4: Regression — existing compliance/screenplay unit tests still pass**

Run:
```bash
npm run test:compliance-grounding
npm run test:compliance-lexicon
```
Expected: unchanged PASS (these are DB-free unit tests).

- [ ] **Step 5: Commit**

```bash
git add .env.example package.json
git commit -m "chore(screenplay): env flags + test aliases for compliance integration"
```

- [ ] **Step 6: Manual smoke checkpoint (requires .env.local + DB + Gemini)**

This loop cannot be unit-tested end-to-end (durable workflow + live Gemini). Verify manually:
1. Ensure `compliance_rules` / `compliance_references` are seeded (admin UI or seed migrations).
2. Generate a screenplay for a product with a known category (e.g. 化粧品) whose draft would normally use an NG phrase.
3. Confirm via the screenplay workspace that the auto-check result shows fewer/zero high violations, and that `screenplay_version_checks.result.remediation.iterations` is populated when a violation was present.
4. Set `SCREENPLAY_AUTO_REMEDIATE=false`, regenerate, confirm the loop is skipped (a check still persists, `remediation.enabled=false`, `iterations=[]`).

---

## Self-Review

**Spec coverage:**
- A (generation-time injection): Tasks 2 (builder), 3 (prompt+types), 8 (workflow load+inject). ✅
- B (sections): Task 1. ✅ B (Tier1+Tier2 hybrid): Task 5. ✅ B (trigger high+lexicon): Task 4. ✅ B (loop ≤3, flag, trail, order restructure): Tasks 6 (types), 7 (callGemini export), 8 (workflow). ✅
- Corpus-only in loop (Codex #1): `safeCheck` calls `checkScreenplay` without `factSearch` (Task 8 Step 4). ✅
- Non-fatal everywhere: `safeCheck` try/catch, remediate try/catch + break, `persistCheckStep` try/catch, Tier2 per-section try/catch. ✅
- No DB migration (trail in `screenplay_version_checks.result`): Task 6 + Task 8 Step 4. ✅
- Tests + env + aliases: Task 9. ✅

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `RemediateResult.{tier1Count,sectionsRewritten,unlocatable}` (Task 5) → consumed in `remediateLoopStep` trail as `{tier1,sections,unlocatable}` (Task 8) — field rename is intentional and complete. `RemediationStep` (Task 6) matches the object pushed in Task 8. `LlmCall` signature `(prompt)=>Promise<string>` matches exported `callGemini` (Task 7). `buildGenerationComplianceBlock(category, rules, references)` (Task 2) called with exactly those args (Task 8 Step 5). `GenerateInput.complianceBlock` (Task 3) consumed by `prompt.ts` (Task 3) and set in `generateStep` (Task 8 Step 3).
