# Screenplay Draft Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator upload an existing `.docx` draft script, normalize it into the system's canonical tagged Markdown (structure only, wording preserved), seed it as version 1, run the baseline compliance check, and then refine it with the existing 改稿 loop.

**Architecture:** A new `lib/screenplay/import/` module extracts `.docx` text (mammoth) and runs a single Gemini "normalize" call → `{ markdown, brief }`. A new `POST /api/screenplays/import` returns that for operator review. `POST /api/screenplays` accepts an `importedMarkdown` field; when present it starts the existing Workflow in a new `import` mode that **skips generation**, seeds v1 directly, runs a **check-only** pass (auto-remediate OFF — faithful import), and persists. Refine/check/export are untouched. UI gains an import form behind a tab switch on `/screenplays/new`.

**Tech Stack:** Next.js 16 App Router, Vercel Workflow (`workflow`), Supabase, `@google/generative-ai` (Gemini 3.5 Flash), `mammoth` (new), `docx` (existing export), Tailwind 4 + shadcn.

**Spec:** `docs/superpowers/specs/2026-06-16-screenplay-draft-import-design.md`

---

## File Structure

New files:
- `lib/screenplay/import/from-docx.ts` — `.docx` → text via mammoth.
- `lib/screenplay/import/normalize-prompt.ts` — `IMPORT_SYSTEM_INSTRUCTION` + `parseImportJson`.
- `lib/screenplay/import/normalize.ts` — Gemini normalize call.
- `lib/screenplay/import/validate.ts` — `validateImportedMarkdown` (DB-free guard).
- `lib/screenplay/import/index.ts` — barrel.
- `app/api/screenplays/import/route.ts` — upload → normalize → `{ markdown, brief, source }`.
- `components/screenplay/ProductBriefEditor.tsx` — shared brief field editor (lifted from create form).
- `components/screenplay/ScreenplayImportForm.tsx` — upload + review + start.
- `components/screenplay/ScreenplayNewTabs.tsx` — client tab switch for `/screenplays/new`.
- `scripts/test-screenplay-import.ts` — units + round-trip fidelity gate + live normalize smoke.

Modified files:
- `lib/screenplay/extract/brief-prompt.ts` — extract `parseBriefObject` core.
- `lib/screenplay/types.ts` — `GenerationMode += "import"`.
- `lib/workflows/screenplay.workflow.ts` — `import` branch, `checkOnlyStep`, `persistCheckStep(autoRemediateEnabled)`, `importedMarkdown` on input.
- `app/api/screenplays/route.ts` — accept + validate `importedMarkdown`, start `import` mode.
- `components/screenplay/ScreenplayCreateForm.tsx` — consume `ProductBriefEditor`.
- `components/screenplay/ScreenplayWorkspace.tsx` — read `?kind=import`, pass `variant`.
- `components/screenplay/GenerationProgress.tsx` — `variant` prop + import copy/steps.
- `app/[locale]/(produce)/screenplays/new/page.tsx` — render `ScreenplayNewTabs`.
- `package.json` — add `mammoth` dep + `test:screenplay-import` script.

---

## Task 1: Add the mammoth dependency

**Files:**
- Modify: `package.json` (+ `package-lock.json`)

- [ ] **Step 1: Install mammoth**

Run:
```bash
npm install mammoth@^1.8.0
```
Expected: `package.json` `dependencies` gains `"mammoth"`, `package-lock.json` updates.

- [ ] **Step 2: Verify it imports under tsx**

Run:
```bash
npx tsx -e "import mammoth from 'mammoth'; console.log(typeof mammoth.extractRawText)"
```
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(screenplay): add mammoth for .docx draft import"
```

---

## Task 2: Extract `parseBriefObject` from `parseBriefJson`

Lets `parseImportJson` reuse brief-field parsing without re-implementing it. Pure mechanical refactor, no behavior change.

**Files:**
- Modify: `lib/screenplay/extract/brief-prompt.ts`
- Create: `scripts/test-screenplay-import.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the test script with `parseBriefObject` units (the failing test)**

Create `scripts/test-screenplay-import.ts`:
```ts
// scripts/test-screenplay-import.ts
//
// Units + round-trip fidelity gate + (skip-guarded) live normalize smoke for
// the Word draft import pipeline.
//   - npx tsx scripts/test-screenplay-import.ts        # units + round-trip (offline)
//   - npm run test:screenplay-import                   # + live Gemini normalize
import { parseBriefObject, parseBriefJson } from "../lib/screenplay/extract/brief-prompt";

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail?: string }[] = [];
function pass(n: string, d = "") { results.push({ name: n, status: "PASS", detail: d }); console.log(`  ✅ ${n}${d ? " — " + d : ""}`); }
function fail(n: string, d = "") { results.push({ name: n, status: "FAIL", detail: d }); console.log(`  ❌ ${n} — ${d}`); }
function skip(n: string, d = "") { results.push({ name: n, status: "SKIP", detail: d }); console.log(`  ⏭️  ${n} — ${d}`); }

function testParseBriefObject() {
  console.log("\n[parseBriefObject] unit");
  try {
    const b = parseBriefObject({ name: "X", description: "D", price: { saleJpy: "9,800" } });
    if (b.name !== "X" || b.description !== "D") throw new Error("field mismatch");
    if (b.price?.saleJpy !== 9800) throw new Error("price string coerce failed");
    pass("parseBriefObject happy path");
  } catch (e) { fail("parseBriefObject happy path", (e as Error).message); }
  try { parseBriefObject({ description: "D" } as Record<string, unknown>); fail("rejects missing name", "did not throw"); }
  catch (e) { pass("rejects missing name", (e as Error).message); }
  try {
    const b = parseBriefJson('{"name":"Y","description":"D2"}');
    if (b.name !== "Y") throw new Error("name mismatch");
    pass("parseBriefJson regression");
  } catch (e) { fail("parseBriefJson regression", (e as Error).message); }
}

async function main() {
  console.log("=== screenplay/import test ===");
  testParseBriefObject();
  const f = results.filter((r) => r.status === "FAIL").length;
  const p = results.filter((r) => r.status === "PASS").length;
  const s = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n=== ${p} pass, ${f} fail, ${s} skip ===`);
  process.exit(f > 0 ? 1 : 0);
}
main().catch((e) => { console.error("Unhandled:", e); process.exit(1); });
```

- [ ] **Step 2: Run it — verify it fails**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: import/run error — `parseBriefObject` is not an export of `brief-prompt.ts`.

- [ ] **Step 3: Refactor `brief-prompt.ts` to expose `parseBriefObject`**

In `lib/screenplay/extract/brief-prompt.ts`, replace the current `parseBriefJson` function (everything from `export function parseBriefJson(text: string): ProductBrief {` through its closing brace) with:
```ts
/** Parse + validate a ProductBrief from an already-parsed JSON object.
 *  Shared by the top-level `parseBriefJson` (extract) and `parseImportJson` (import). */
export function parseBriefObject(obj: Record<string, unknown>): ProductBrief {
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  if (!name) throw new Error("抽出結果に商品名がありません");
  if (!description) throw new Error("抽出結果に商品説明がありません");

  const brief: ProductBrief = { name: name.slice(0, 200), description: description.slice(0, 16_000) };

  if (typeof obj.category === "string" && obj.category.trim()) {
    brief.category = obj.category.trim().slice(0, 200);
  }
  if (typeof obj.guarantee === "string" && obj.guarantee.trim()) {
    brief.guarantee = obj.guarantee.trim().slice(0, 500);
  }
  if (typeof obj.notes === "string" && obj.notes.trim()) {
    brief.notes = obj.notes.trim().slice(0, 4000);
  }
  if (Array.isArray(obj.bonuses)) {
    const bonuses = obj.bonuses
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, 20)
      .map((s) => s.trim().slice(0, 200));
    if (bonuses.length) brief.bonuses = bonuses;
  }
  if (obj.price && typeof obj.price === "object") {
    const p = obj.price as Record<string, unknown>;
    const num = (v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
      if (typeof v === "string") {
        const n = Number(v.replace(/[, ¥円\s]/g, ""));
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
      }
      return undefined;
    };
    const list = num(p.listJpy);
    const sale = num(p.saleJpy);
    const shipping = num(p.shippingJpy);
    const price: NonNullable<ProductBrief["price"]> = {};
    if (list !== undefined) price.listJpy = list;
    if (sale !== undefined) price.saleJpy = sale;
    if (shipping !== undefined) price.shippingJpy = shipping;
    if (Object.keys(price).length) brief.price = price;
  }
  return brief;
}

export function parseBriefJson(text: string): ProductBrief {
  const trimmed = text.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini did not return JSON");
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  return parseBriefObject(obj);
}
```

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, after the `"test:screenplay-docx"` line, add:
```json
    "test:screenplay-import": "tsx --env-file=.env.local scripts/test-screenplay-import.ts",
```

- [ ] **Step 5: Run it — verify it passes**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: `3 pass, 0 fail, 0 skip`.

- [ ] **Step 6: Verify the existing extract test still passes (regression)**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/screenplay/extract/brief-prompt.ts scripts/test-screenplay-import.ts package.json
git commit -m "refactor(screenplay): extract parseBriefObject for import reuse"
```

---

## Task 3: Import normalize prompt + `parseImportJson`

**Files:**
- Create: `lib/screenplay/import/normalize-prompt.ts`
- Modify: `scripts/test-screenplay-import.ts`

- [ ] **Step 1: Add `parseImportJson` unit tests (the failing test)**

In `scripts/test-screenplay-import.ts`, add the import at the top (after the existing `parseBriefObject` import):
```ts
import { parseImportJson, IMPORT_MARKDOWN_MAX } from "../lib/screenplay/import/normalize-prompt";
```
Add this function before `main()`:
```ts
function testParseImportJson() {
  console.log("\n[parseImportJson] unit");
  try {
    const r = parseImportJson(JSON.stringify({
      markdown: "# 台本\n\n[N] （明るく）\nこんにちは。",
      brief: { name: "商品A", description: "説明テキスト" },
    }));
    if (!r.markdown.includes("こんにちは")) throw new Error("markdown lost");
    if (r.brief.name !== "商品A") throw new Error("brief.name mismatch");
    pass("parseImportJson happy path");
  } catch (e) { fail("parseImportJson happy path", (e as Error).message); }

  try { parseImportJson(JSON.stringify({ brief: { name: "A", description: "D" } })); fail("rejects missing markdown", "did not throw"); }
  catch (e) { pass("rejects missing markdown", (e as Error).message); }

  try { parseImportJson(JSON.stringify({ markdown: "x" })); fail("rejects missing brief", "did not throw"); }
  catch (e) { pass("rejects missing brief", (e as Error).message); }

  try {
    const big = "あ".repeat(IMPORT_MARKDOWN_MAX + 500);
    const r = parseImportJson(JSON.stringify({ markdown: "# h\n" + big, brief: { name: "A", description: "D" } }));
    if (r.markdown.length > IMPORT_MARKDOWN_MAX) throw new Error(`not capped: ${r.markdown.length}`);
    pass("caps oversized markdown");
  } catch (e) { fail("caps oversized markdown", (e as Error).message); }

  try {
    const r = parseImportJson('prefix ```json\n{"markdown":"# t\\n本文","brief":{"name":"A","description":"D"}}\n``` suffix');
    if (!r.markdown.includes("本文")) throw new Error("did not strip prose/fence");
    pass("strips surrounding prose / code fence");
  } catch (e) { fail("strips surrounding prose / code fence", (e as Error).message); }
}
```
Register it inside `main()` after `testParseBriefObject();`:
```ts
  testParseImportJson();
```

- [ ] **Step 2: Run it — verify it fails**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: import/run error — `normalize-prompt` module does not exist.

- [ ] **Step 3: Create `lib/screenplay/import/normalize-prompt.ts`**

```ts
// lib/screenplay/import/normalize-prompt.ts
// Structure-only normalization contract for importing an existing draft script.
// Deliberately NOT the generation SYSTEM_INSTRUCTION: that one forces the full
// アバン/スタジオ①〜④/CTA/VTR/価格 skeleton. Import must NEVER invent absent sections.
// No "server-only" import — must load under tsx smoke scripts.
import type { ProductBrief } from "../types";
import { parseBriefObject } from "../extract/brief-prompt";

export const IMPORT_MARKDOWN_MAX = 60_000;

export interface NormalizedDraft {
  markdown: string;
  brief: ProductBrief;
}

export const IMPORT_SYSTEM_INSTRUCTION = `あなたは日本のテレビショッピング台本の編集アシスタントです。
ユーザーが Word で作成した「既存の台本ドラフト」を、当システムの標準フォーマットに **構造だけ** 整形します。

# 絶対原則（最重要）
- これは「忠実な取り込み」です。原文の文言・セリフ・情報を **保持** してください。
- 要約・加筆・品質改善・コンプライアンス上の言い換えは **禁止**。文章を書き換えないこと。
- 原文に **存在しないセクション**（CTA・お客様VTR・価格表・メタ情報・スタイルノート等）を **新規に作ってはいけません**。原文にあるものだけを残す。
- 原文の言語をそのまま保持。翻訳しない。英語を消したり足したりしない。

# あなたの仕事は「構造のタグ付け」だけ
入力テキスト（プレーンテキストまたは HTML。HTML の場合は表のセル境界が話者と台詞の区切りを表す）を読み、当システムの Markdown タグに割り当て直す：

- 見出し: \`#\` / \`##\` / \`###\`
- 場面転換・アクト境界: \`---\`
- 話者ブロックは必ず次の形式（1行で完結）：
  [役名] （演出メモがあれば日本語で）
  セリフ本文
  役名タグは可能なら次に正規化：[N]（ナレーター） [高橋] [山内] [小島] [お客様] [XX先生]（専門家）。
  原文の話者がこれらに **明確に対応しない** 場合は、原文の名前をそのまま [名前] として残す（推測で割り当てない）。
- 演出キューは独立ブロック：[テロップ] [カメラ] [BGM] [SE] [インサート] [小道具]。
  原文にそれらの指示があれば対応するタグに入れる。無ければ作らない。

# 商品情報 (brief) の抽出
台本本文から読み取れる範囲で ProductBrief を抽出する（捏造禁止、不明項目は省略）。
- name: 商品名（必須。台本から判断できる正式名称に最も近いもの）
- description: 台本から読み取れる商品の特徴・訴求を 200〜2000 文字程度の日本語で要約
- category / price(listJpy/saleJpy/shippingJpy は日本円の整数) / bonuses[] / guarantee / notes は分かる場合のみ

# 出力
厳密な JSON のみ。前置き・説明・コードフェンス禁止。
{
  "markdown": "整形済みの台本全文（原文の文言を保持）",
  "brief": { "name": string, "category"?: string, "description": string, "price"?: { "listJpy"?: number, "saleJpy"?: number, "shippingJpy"?: number }, "bonuses"?: string[], "guarantee"?: string, "notes"?: string }
}`;

export function parseImportJson(text: string): NormalizedDraft {
  const trimmed = text.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini did not return JSON");
  const obj = JSON.parse(match[0]) as Record<string, unknown>;

  const markdownRaw = typeof obj.markdown === "string" ? obj.markdown.trim() : "";
  if (!markdownRaw) throw new Error("正規化結果に台本本文 (markdown) がありません");
  const markdown = markdownRaw.slice(0, IMPORT_MARKDOWN_MAX);

  if (!obj.brief || typeof obj.brief !== "object") {
    throw new Error("正規化結果に商品情報 (brief) がありません");
  }
  const brief = parseBriefObject(obj.brief as Record<string, unknown>);

  return { markdown, brief };
}
```

- [ ] **Step 4: Run it — verify it passes**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: `8 pass, 0 fail, 0 skip`.

- [ ] **Step 5: Commit**

```bash
git add lib/screenplay/import/normalize-prompt.ts scripts/test-screenplay-import.ts
git commit -m "feat(screenplay): import normalize prompt + parseImportJson"
```

---

## Task 4: DOCX text extraction + round-trip fidelity gate

**Files:**
- Create: `lib/screenplay/import/from-docx.ts`
- Modify: `scripts/test-screenplay-import.ts`

- [ ] **Step 1: Add the round-trip fidelity test (the failing test)**

In `scripts/test-screenplay-import.ts`, add imports at the top:
```ts
import { extractDocxText } from "../lib/screenplay/import/from-docx";
import { buildScreenplayDocxBuffer } from "../lib/screenplay/screenplay-docx";
```
Add this function before `main()`:
```ts
// Our DOCX export renders speaker blocks as borderless 2-col tables and cues as
// ［tag］ paragraphs. The gate: after a round-trip, the extracted raw text must
// still carry the role tokens, cue label, and dialogue — enough for the LLM to
// re-tag. (Bracket tags are NOT expected to survive; the export writes bare roles.)
async function testDocxRoundTrip() {
  console.log("\n[from-docx] round-trip fidelity gate");
  const md = [
    "# テスト台本 — 取り込み確認",
    "",
    "## オープニング",
    "",
    "[テロップ] 本日限定のご案内",
    "",
    "[高橋] （落ち着いて）",
    "この商品の特長をご説明します。",
    "",
    "[山内] （驚いて）",
    "それは便利ですね！",
    "",
    "---",
    "",
    "ふつうの段落。",
  ].join("\n");
  try {
    const buf = await buildScreenplayDocxBuffer(md, "テスト台本");
    const { text } = await extractDocxText(Buffer.from(buf));
    for (const token of ["高橋", "山内", "テロップ", "この商品の特長をご説明します", "それは便利ですね"]) {
      if (!text.includes(token)) throw new Error(`token lost after round-trip: "${token}"`);
    }
    pass("round-trip preserves role/cue/dialogue tokens", `${text.length} chars`);
  } catch (e) { fail("round-trip preserves role/cue/dialogue tokens", (e as Error).message); }

  try { await extractDocxText(Buffer.from([0x00, 0x01, 0x02, 0x03])); fail("rejects non-docx bytes", "did not throw"); }
  catch (e) { pass("rejects non-docx bytes", (e as Error).message.slice(0, 80)); }
}
```
Register it inside `main()` after `testParseImportJson();`:
```ts
  await testDocxRoundTrip();
```

- [ ] **Step 2: Run it — verify it fails**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: import/run error — `from-docx` module does not exist.

- [ ] **Step 3: Create `lib/screenplay/import/from-docx.ts`**

```ts
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
```

- [ ] **Step 4: Run it — verify it passes**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: `10 pass, 0 fail, 0 skip`. (If the round-trip token assertion fails, follow the `convertToHtml` note in the file comment before proceeding.)

- [ ] **Step 5: Commit**

```bash
git add lib/screenplay/import/from-docx.ts scripts/test-screenplay-import.ts
git commit -m "feat(screenplay): .docx text extraction + round-trip fidelity gate"
```

---

## Task 5: Gemini normalize call + barrel + live smoke

**Files:**
- Create: `lib/screenplay/import/normalize.ts`
- Create: `lib/screenplay/import/index.ts`
- Modify: `scripts/test-screenplay-import.ts`

- [ ] **Step 1: Add the live normalize smoke (skip-guarded)**

In `scripts/test-screenplay-import.ts`, add the import at the top:
```ts
import { normalizeDraft } from "../lib/screenplay/import/normalize";
```
Add this function before `main()`:
```ts
async function testNormalizeLive() {
  console.log("\n[normalize] live Gemini smoke");
  if (!process.env.GEMINI_API_KEY) { skip("normalizeDraft", "GEMINI_API_KEY not set"); return; }
  const draft = [
    "ナレーター: 毎朝の掃除、大変ですよね。",
    "高橋さん: そこでこちらのモップが活躍します。吸水力が違います。",
    "山内: へえ、本当だ！",
    "テロップ: 今だけ送料無料",
  ].join("\n");
  try {
    const r = await normalizeDraft(draft, "draft.docx");
    if (!r.brief.name || !r.brief.name.trim()) throw new Error("brief.name empty");
    if (!r.markdown.trim()) throw new Error("markdown empty");
    if (/CTA|お客様VTR|価格表/.test(r.markdown) && !/モップ/.test(draft)) {
      // sanity only; not a hard fail
    }
    pass("normalizeDraft returns markdown + brief", `name="${r.brief.name}" md=${r.markdown.length} chars`);
  } catch (e) { fail("normalizeDraft returns markdown + brief", (e as Error).message); }
}
```
Register it inside `main()` after `await testDocxRoundTrip();`:
```ts
  await testNormalizeLive();
```

- [ ] **Step 2: Run it — verify it fails**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: import/run error — `normalize` module does not exist.

- [ ] **Step 3: Create `lib/screenplay/import/normalize.ts`**

```ts
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
```

- [ ] **Step 4: Create the barrel `lib/screenplay/import/index.ts`**

```ts
// lib/screenplay/import/index.ts
export { extractDocxText } from "./from-docx";
export type { DocxExtractResult } from "./from-docx";
export { normalizeDraft } from "./normalize";
export { IMPORT_SYSTEM_INSTRUCTION, parseImportJson, IMPORT_MARKDOWN_MAX } from "./normalize-prompt";
export type { NormalizedDraft } from "./normalize-prompt";
export { validateImportedMarkdown, IMPORTED_MARKDOWN_MAX } from "./validate";
export type { ImportedMarkdownValidation } from "./validate";
```
(`validate.ts` is created in Task 6; this re-export is forward-declared and will resolve then. If running tsc before Task 6, temporarily omit the last two lines.)

- [ ] **Step 5: Run the offline portion — verify units still pass + live skips**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: `10 pass, 0 fail, 1 skip` (live normalize skipped without key).

- [ ] **Step 6: Run the live smoke (requires `.env.local` with `GEMINI_API_KEY`)**

Run:
```bash
npm run test:screenplay-import
```
Expected: `11 pass, 0 fail, 0 skip` — `normalizeDraft returns markdown + brief` PASSes with a non-empty brief name.

- [ ] **Step 7: Commit**

```bash
git add lib/screenplay/import/normalize.ts lib/screenplay/import/index.ts scripts/test-screenplay-import.ts
git commit -m "feat(screenplay): Gemini draft normalizer + import barrel"
```

---

## Task 6: `validateImportedMarkdown` server guard

**Files:**
- Create: `lib/screenplay/import/validate.ts`
- Modify: `scripts/test-screenplay-import.ts`

- [ ] **Step 1: Add validate units (the failing test)**

In `scripts/test-screenplay-import.ts`, add the import:
```ts
import { validateImportedMarkdown, IMPORTED_MARKDOWN_MAX } from "../lib/screenplay/import/validate";
```
Add this function before `main()`:
```ts
function testValidateImportedMarkdown() {
  console.log("\n[validateImportedMarkdown] unit");
  const cases: { name: string; input: unknown; ok: boolean }[] = [
    { name: "accepts heading-structured md", input: "# 台本\n\n本文がここに入ります。", ok: true },
    { name: "accepts speaker-tagged md", input: "[N]\nこんにちは。\n[高橋]\nどうも。", ok: true },
    { name: "accepts >=8 non-empty lines", input: Array.from({ length: 8 }, (_, i) => `行${i}`).join("\n"), ok: true },
    { name: "rejects empty", input: "   \n  ", ok: false },
    { name: "rejects non-string", input: 123, ok: false },
    { name: "rejects structureless short blob", input: "あいうえお", ok: false },
    { name: "rejects oversized", input: "# h\n" + "あ".repeat(IMPORTED_MARKDOWN_MAX + 10), ok: false },
  ];
  for (const c of cases) {
    const r = validateImportedMarkdown(c.input);
    if (r.ok === c.ok) pass(c.name, r.ok ? "ok" : r.error);
    else fail(c.name, `expected ok=${c.ok}, got ok=${r.ok} (${r.error ?? ""})`);
  }
}
```
Register it inside `main()` after `testParseImportJson();` (order among units doesn't matter):
```ts
  testValidateImportedMarkdown();
```

- [ ] **Step 2: Run it — verify it fails**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: import/run error — `validate` module does not exist.

- [ ] **Step 3: Create `lib/screenplay/import/validate.ts`**

```ts
// lib/screenplay/import/validate.ts
// DB-free guard for operator-reviewed imported markdown re-sent to POST /api/screenplays.
// No "server-only" — importable from tsx smoke scripts.

export const IMPORTED_MARKDOWN_MAX = 60_000;

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
  if (md.length > IMPORTED_MARKDOWN_MAX) {
    return { ok: false, error: `台本が長すぎます（最大 ${IMPORTED_MARKDOWN_MAX.toLocaleString()} 文字）` };
  }
  const nonEmptyLines = md.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  const hasStructure = HEADING_RE.test(md) || TAG_RE.test(md) || nonEmptyLines >= 8;
  if (!hasStructure) {
    return { ok: false, error: "台本の構造を認識できません（見出し・話者タグ・十分な行数のいずれも見つかりません）" };
  }
  return { ok: true, markdown: md };
}
```

- [ ] **Step 4: Run it — verify it passes**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: `17 pass, 0 fail, 1 skip` (offline) — the 7 validate cases now pass.

- [ ] **Step 5: tsc check (the barrel now fully resolves)**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/import/validate.ts scripts/test-screenplay-import.ts
git commit -m "feat(screenplay): validateImportedMarkdown server guard"
```

---

## Task 7: Add `"import"` to `GenerationMode`

**Files:**
- Modify: `lib/screenplay/types.ts:2`

- [ ] **Step 1: Widen the union**

In `lib/screenplay/types.ts`, change:
```ts
export type GenerationMode = "initial" | "refine";
```
to:
```ts
export type GenerationMode = "initial" | "refine" | "import";
```

- [ ] **Step 2: tsc check**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors (the workflow's mode switch is `=== "refine"` / else, so the new member compiles).

- [ ] **Step 3: Commit**

```bash
git add lib/screenplay/types.ts
git commit -m "feat(screenplay): add 'import' generation mode"
```

---

## Task 8: Workflow `import` branch + honest remediation metadata

**Files:**
- Modify: `lib/workflows/screenplay.workflow.ts`

- [ ] **Step 1: Add `importedMarkdown` to the workflow input**

In `lib/workflows/screenplay.workflow.ts`, change the `ScreenplayWorkflowInput` interface:
```ts
export interface ScreenplayWorkflowInput {
  screenplayId: string;
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;
  baseVersionId?: string;
}
```
to:
```ts
export interface ScreenplayWorkflowInput {
  screenplayId: string;
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;
  baseVersionId?: string;
  /** Present only in mode "import": operator-reviewed, pre-normalized v1 markdown. */
  importedMarkdown?: string;
}
```

- [ ] **Step 2: Make `persistCheckStep` take an explicit `autoRemediateEnabled`**

Replace the `persistCheckStep` signature line and the `enabled:` line. Change:
```ts
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
```
to:
```ts
async function persistCheckStep(
	versionId: string,
	check: ScriptCheckResult | null,
	trail: RemediationStep[],
	rulesLen: number,
	refsLen: number,
	autoRemediateEnabled: boolean,
): Promise<void> {
	"use step";
	// Non-fatal: a failed persist must NEVER fail the generation.
	if (!check) return;
	try {
		const supabase = getServiceClient();
		const result: ScriptCheckResult = {
			...check,
			remediation: { enabled: autoRemediateEnabled, iterations: trail, finalHigh: countHigh(check) },
		};
```

- [ ] **Step 3: Add a `checkOnlyStep` (single corpus-only check, no remediate loop)**

In `lib/workflows/screenplay.workflow.ts`, add this function immediately after `remediateLoopStep` (before `persistCheckStep`):
```ts
async function checkOnlyStep(
	markdown: string,
	brief: ProductBrief,
	rules: ComplianceRule[],
	references: ComplianceReference[],
): Promise<ScriptCheckResult | null> {
	"use step";
	await writeProgressInline({ type: "step", name: "check", status: "started" });
	const check = await safeCheck(markdown, brief, rules, references);
	await writeProgressInline({ type: "step", name: "check", status: "completed" });
	return check;
}
```

- [ ] **Step 4: Add the `import` branch + update the generate-path `persistCheckStep` call**

In `screenplayWorkflow`, the current body is:
```ts
export async function screenplayWorkflow(input: ScreenplayWorkflowInput) {
  "use workflow";

  try {
    let previousMarkdown: string | undefined;
    if (input.mode === "refine") {
```
Insert the import branch right after `try {` (before `let previousMarkdown`):
```ts
  try {
    if (input.mode === "import") {
      if (!input.importedMarkdown) throw new FatalError("import mode requires importedMarkdown");
      await emitProgressStep({ type: "step", name: "import", status: "started" });
      const markdown = input.importedMarkdown;
      await emitProgressStep({ type: "step", name: "import", status: "completed" });

      const { rules, references } = await loadComplianceStep();
      // Faithful import: corpus-only check, NO auto-remediate (the draft is the contract).
      const check = await checkOnlyStep(markdown, input.productBrief, rules, references);

      const persisted = await persistStep(
        input.screenplayId,
        markdown,
        "Word ドラフト取り込み",
        undefined,
        "imported",
        "none",
      );
      await persistCheckStep(persisted.versionId, check, [], rules.length, references.length, false);

      await emitProgressStep({
        type: "done",
        screenplayId: input.screenplayId,
        versionId: persisted.versionId,
        versionNumber: persisted.versionNumber,
      });
      return { screenplayId: input.screenplayId, ...persisted };
    }

    let previousMarkdown: string | undefined;
    if (input.mode === "refine") {
```
Then update the existing generate-path call (currently `await persistCheckStep(persisted.versionId, check, trail, rules.length, references.length);`) to pass the flag:
```ts
    await persistCheckStep(persisted.versionId, check, trail, rules.length, references.length, AUTO_REMEDIATE);
```

- [ ] **Step 5: tsc check**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Verify existing screenplay generator/check tests still compile/run (regression)**

Run:
```bash
npx tsx scripts/test-screenplay-import.ts
```
Expected: still `17 pass, 0 fail, 1 skip` (no behavior change to import units).

- [ ] **Step 7: Commit**

```bash
git add lib/workflows/screenplay.workflow.ts
git commit -m "feat(screenplay): workflow import branch (check-only, auto-remediate off)"
```

---

## Task 9: `POST /api/screenplays/import`

**Files:**
- Create: `app/api/screenplays/import/route.ts`

- [ ] **Step 1: Create the route**

```ts
// app/api/screenplays/import/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { extractDocxText, normalizeDraft } from "@/lib/screenplay/import";
import { checkMagicBytes } from "@/lib/upload/magic-bytes";

export const maxDuration = 120;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function POST(request: NextRequest) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Content-Type は multipart/form-data を指定してください" }, { status: 415 });
  }

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file フィールドにファイルを添付してください" }, { status: 400 });
    }
    if (file.size === 0) return NextResponse.json({ error: "ファイルが空です" }, { status: 400 });
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "ファイルサイズが大きすぎます (最大 25MB)" }, { status: 413 });
    }

    const fileName = file.name || "draft.docx";
    const lower = fileName.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());

    // .docx only. Magic bytes must be a ZIP/OOXML wordprocessing doc.
    // .doc (OLE2) and anything else → 415.
    const magic = checkMagicBytes(buffer, DOCX_MIME);
    if (!lower.endsWith(".docx") || magic.kind !== "match") {
      const isLegacyDoc = lower.endsWith(".doc") || magic.detectedMime === "application/x-cfb";
      return NextResponse.json(
        {
          error: isLegacyDoc
            ? "旧 .doc 形式は非対応です。Word で「.docx」形式に保存し直してアップロードしてください。"
            : `非対応のファイル形式です (${fileName})。Word の .docx のみ対応しています。`,
        },
        { status: 415 },
      );
    }

    const { text } = await extractDocxText(buffer);
    const { markdown, brief } = await normalizeDraft(text, fileName);

    return NextResponse.json({
      markdown,
      brief,
      source: { kind: "docx", fileName, size: file.size },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[screenplays/import] failed:", msg);
    return NextResponse.json({ error: `取り込みに失敗しました: ${msg}` }, { status: 500 });
  }
}
```

- [ ] **Step 2: tsc check**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Lint check**

Run:
```bash
npm run lint
```
Expected: no errors for the new route.

- [ ] **Step 4: Commit**

```bash
git add app/api/screenplays/import/route.ts
git commit -m "feat(screenplay): POST /api/screenplays/import (docx → normalize)"
```

---

## Task 10: `POST /api/screenplays` accepts `importedMarkdown`

**Files:**
- Modify: `app/api/screenplays/route.ts`

- [ ] **Step 1: Import the validator**

In `app/api/screenplays/route.ts`, add to the imports:
```ts
import { validateImportedMarkdown } from "@/lib/screenplay/import/validate";
```

- [ ] **Step 2: Validate `importedMarkdown` and branch the workflow start**

In the `POST` handler, the current code after `const { brief: productBrief } = v;` is:
```ts
		const { brief: productBrief } = v;

		const { data: inserted, error: insErr } = await supabase
			.from("screenplays")
			.insert({
				product_id: v.productId,
				title: productBrief.name,
				product_info_snapshot: productBrief,
				status: "generating",
			})
			.select("id")
			.single();
		if (insErr || !inserted) {
			console.error("[screenplays] insert failed:", insErr);
			return Response.json({ error: "台本の作成に失敗しました" }, { status: 500 });
		}
		const screenplayId = inserted.id as string;

		try {
			const run = await start(screenplayWorkflow, [{
				screenplayId,
				mode: "initial",
				productBrief,
			}]);
```
Replace it with (adds the `importedMarkdown` validation + the mode branch):
```ts
		const { brief: productBrief } = v;

		// Import path: an operator-reviewed, pre-normalized draft seeds v1 directly.
		let importedMarkdown: string | undefined;
		if (body && typeof body === "object" && "importedMarkdown" in (body as Record<string, unknown>)) {
			const val = validateImportedMarkdown((body as Record<string, unknown>).importedMarkdown);
			if (!val.ok) return Response.json({ error: val.error }, { status: 400 });
			importedMarkdown = val.markdown;
		}

		const { data: inserted, error: insErr } = await supabase
			.from("screenplays")
			.insert({
				product_id: v.productId,
				title: productBrief.name,
				product_info_snapshot: productBrief,
				status: "generating",
			})
			.select("id")
			.single();
		if (insErr || !inserted) {
			console.error("[screenplays] insert failed:", insErr);
			return Response.json({ error: "台本の作成に失敗しました" }, { status: 500 });
		}
		const screenplayId = inserted.id as string;

		try {
			const run = await start(screenplayWorkflow, [
				importedMarkdown
					? { screenplayId, mode: "import" as const, productBrief, importedMarkdown }
					: { screenplayId, mode: "initial" as const, productBrief },
			]);
```

- [ ] **Step 3: tsc check**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/screenplays/route.ts
git commit -m "feat(screenplay): accept importedMarkdown, start import-mode workflow"
```

---

## Task 11: Extract `ProductBriefEditor` and reuse in `ScreenplayCreateForm`

**Files:**
- Create: `components/screenplay/ProductBriefEditor.tsx`
- Modify: `components/screenplay/ScreenplayCreateForm.tsx`

- [ ] **Step 1: Create `ProductBriefEditor.tsx`**

```tsx
"use client";

export interface BriefDraft {
	name: string;
	category?: string;
	description: string;
	guarantee?: string;
	notes?: string;
}

interface Props {
	brief: BriefDraft;
	onBriefChange: (b: BriefDraft) => void;
	bonusesText: string;
	onBonusesChange: (s: string) => void;
	listPrice: string;
	salePrice: string;
	shippingPrice: string;
	onListPrice: (s: string) => void;
	onSalePrice: (s: string) => void;
	onShippingPrice: (s: string) => void;
}

const inputCls =
	"w-full px-3.5 py-2.5 text-sm bg-card border border-border rounded-lg shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-4 focus:ring-blue-500/15 focus:border-blue-500 transition-shadow";

export function ProductBriefEditor({
	brief,
	onBriefChange,
	bonusesText,
	onBonusesChange,
	listPrice,
	salePrice,
	shippingPrice,
	onListPrice,
	onSalePrice,
	onShippingPrice,
}: Props) {
	return (
		<div className="p-6 space-y-7">
			{/* 基本情報 */}
			<section>
				<div className="flex items-center gap-3 mb-3">
					<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">基本情報</h3>
					<div className="h-px flex-1 bg-border" aria-hidden />
				</div>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div className="md:col-span-2">
						<label className="block text-xs font-medium text-foreground mb-1.5">
							商品名 <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							value={brief.name}
							onChange={(e) => onBriefChange({ ...brief, name: e.target.value })}
							className={inputCls}
							maxLength={200}
						/>
					</div>
					<div className="md:col-span-2">
						<label className="block text-xs font-medium text-foreground mb-1.5">カテゴリ</label>
						<input
							type="text"
							value={brief.category ?? ""}
							onChange={(e) => onBriefChange({ ...brief, category: e.target.value })}
							className={inputCls}
							maxLength={200}
						/>
					</div>
					<div className="md:col-span-2">
						<label className="block text-xs font-medium text-foreground mb-1.5">
							特徴・スペック <span className="text-red-500">*</span>
						</label>
						<textarea
							value={brief.description}
							onChange={(e) => onBriefChange({ ...brief, description: e.target.value })}
							rows={8}
							className={`${inputCls} resize-y leading-relaxed`}
							maxLength={16000}
						/>
						<div className="flex items-center justify-end mt-1">
							<p className="text-[11px] text-muted-foreground tabular-nums">
								{brief.description.length.toLocaleString()} / 16,000 文字
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* 価格 */}
			<section>
				<div className="flex items-center gap-3 mb-3">
					<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">価格</h3>
					<div className="h-px flex-1 bg-border" aria-hidden />
				</div>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					{([
						["メーカー直販価格", listPrice, onListPrice],
						["本日特別価格", salePrice, onSalePrice],
						["送料", shippingPrice, onShippingPrice],
					] as const).map(([label, val, setter]) => (
						<div key={label}>
							<label className="block text-xs font-medium text-foreground mb-1.5">{label}</label>
							<div className="relative">
								<span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">¥</span>
								<input
									type="number"
									inputMode="numeric"
									value={val}
									onChange={(e) => setter(e.target.value)}
									min={0}
									className={`${inputCls} pl-7 tabular-nums`}
								/>
							</div>
						</div>
					))}
				</div>
			</section>

			{/* 特典・補足 */}
			<section>
				<div className="flex items-center gap-3 mb-3">
					<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">特典・補足</h3>
					<div className="h-px flex-1 bg-border" aria-hidden />
				</div>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label className="block text-xs font-medium text-foreground mb-1.5">保証</label>
						<input
							type="text"
							value={brief.guarantee ?? ""}
							onChange={(e) => onBriefChange({ ...brief, guarantee: e.target.value })}
							className={inputCls}
							maxLength={500}
						/>
					</div>
					<div>
						<label className="block text-xs font-medium text-foreground mb-1.5">ボーナス・特典 (1行1件)</label>
						<textarea
							value={bonusesText}
							onChange={(e) => onBonusesChange(e.target.value)}
							rows={3}
							className={`${inputCls} resize-none`}
						/>
					</div>
					<div className="md:col-span-2">
						<label className="block text-xs font-medium text-foreground mb-1.5">その他のメモ</label>
						<textarea
							value={brief.notes ?? ""}
							onChange={(e) => onBriefChange({ ...brief, notes: e.target.value })}
							rows={3}
							className={`${inputCls} resize-none`}
							maxLength={4000}
						/>
					</div>
				</div>
			</section>
		</div>
	);
}
```

- [ ] **Step 2: Wire `ProductBriefEditor` into `ScreenplayCreateForm`**

In `components/screenplay/ScreenplayCreateForm.tsx`:

(a) Add the import near the top:
```tsx
import { ProductBriefEditor } from "./ProductBriefEditor";
```

(b) Change the `ExtractedBrief` state usage: the inline fields block (the `<div className="p-6 space-y-7">` containing the three `<section>` elements — currently lines ~575–721, from `{/* Section: 基本情報 */}` through the close of the 特典・補足 section's wrapping `</div>`) is replaced by:
```tsx
						<ProductBriefEditor
							brief={{
								name: brief.name,
								category: brief.category,
								description: brief.description,
								guarantee: brief.guarantee,
								notes: brief.notes,
							}}
							onBriefChange={(b) => setBrief({ ...brief, ...b })}
							bonusesText={bonusesText}
							onBonusesChange={setBonusesText}
							listPrice={listPrice}
							salePrice={salePrice}
							shippingPrice={shippingPrice}
							onListPrice={setListPrice}
							onSalePrice={setSalePrice}
							onShippingPrice={setShippingPrice}
						/>
```
Keep the surrounding card markup (the header strip + source breadcrumb above, and the closing `</div>` of the card). Only the inner fields block is swapped.

- [ ] **Step 3: tsc + lint check**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: no errors. (If `inputCls` is now unused in `ScreenplayCreateForm.tsx` because all its consumers moved to the editor, leave it only if still referenced by the URL/upload inputs — it IS still used by the URL input field, so keep it.)

- [ ] **Step 4: Commit**

```bash
git add components/screenplay/ProductBriefEditor.tsx components/screenplay/ScreenplayCreateForm.tsx
git commit -m "refactor(screenplay): extract shared ProductBriefEditor"
```

---

## Task 12: `ScreenplayImportForm`

**Files:**
- Create: `components/screenplay/ScreenplayImportForm.tsx`

- [ ] **Step 1: Create the import form**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
	Upload, Loader2, FileText, X, Wand2, AlertCircle, CheckCircle2,
	RotateCcw, Sparkles, ArrowRight, ChevronDown, ChevronUp,
} from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";
import { ProductBriefEditor, type BriefDraft } from "./ProductBriefEditor";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface ExtractedBrief extends BriefDraft {
	price?: { listJpy?: number; saleJpy?: number; shippingJpy?: number };
	bonuses?: string[];
}

function priceToString(n: number | undefined): string {
	return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
}
function parsePrice(s: string): number | undefined {
	const cleaned = s.replace(/[, ¥円\s]/g, "");
	if (!cleaned) return undefined;
	const n = Number(cleaned);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
	return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function ScreenplayImportForm({ locale }: { locale: string }) {
	const router = useRouter();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [extracting, setExtracting] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);

	const [markdown, setMarkdown] = useState<string | null>(null);
	const [brief, setBrief] = useState<BriefDraft | null>(null);
	const [bonusesText, setBonusesText] = useState("");
	const [listPrice, setListPrice] = useState("");
	const [salePrice, setSalePrice] = useState("");
	const [shippingPrice, setShippingPrice] = useState("");
	const [showPreview, setShowPreview] = useState(false);

	function hydrate(b: ExtractedBrief, md: string) {
		setBrief({ name: b.name, category: b.category, description: b.description, guarantee: b.guarantee, notes: b.notes });
		setBonusesText((b.bonuses ?? []).join("\n"));
		setListPrice(priceToString(b.price?.listJpy));
		setSalePrice(priceToString(b.price?.saleJpy));
		setShippingPrice(priceToString(b.price?.shippingJpy));
		setMarkdown(md);
	}

	function resetAll() {
		setSelectedFile(null);
		setMarkdown(null);
		setBrief(null);
		setBonusesText("");
		setListPrice("");
		setSalePrice("");
		setShippingPrice("");
		setError(null);
		if (fileInputRef.current) fileInputRef.current.value = "";
	}

	async function runImport() {
		if (!selectedFile) return;
		setExtracting(true);
		setError(null);
		try {
			const form = new FormData();
			form.append("file", selectedFile);
			const res = await fetch("/api/screenplays/import", { method: "POST", body: form });
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? "取り込みに失敗しました");
			if (!j.brief || typeof j.markdown !== "string") throw new Error("サーバーから取り込み結果が返りませんでした");
			hydrate(j.brief as ExtractedBrief, j.markdown as string);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExtracting(false);
		}
	}

	async function submit() {
		if (!brief || !markdown) return;
		const name = brief.name.trim();
		const description = brief.description.trim();
		if (!name || !description) {
			setError("商品名と特徴・スペックは必須です");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const bonuses = bonusesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
			const price: ExtractedBrief["price"] = {};
			const list = parsePrice(listPrice);
			const sale = parsePrice(salePrice);
			const ship = parsePrice(shippingPrice);
			if (list !== undefined) price.listJpy = list;
			if (sale !== undefined) price.saleJpy = sale;
			if (ship !== undefined) price.shippingJpy = ship;

			const productBrief: ExtractedBrief = { name, description };
			if (brief.category?.trim()) productBrief.category = brief.category.trim();
			if (brief.guarantee?.trim()) productBrief.guarantee = brief.guarantee.trim();
			if (brief.notes?.trim()) productBrief.notes = brief.notes.trim();
			if (bonuses.length) productBrief.bonuses = bonuses;
			if (Object.keys(price).length) productBrief.price = price;

			const res = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productBrief, importedMarkdown: markdown }),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? "作成に失敗しました");
			router.push(localePath(locale, `/screenplays/${j.id}?run=${j.runId}&kind=import`));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setSubmitting(false);
		}
	}

	function onDropFiles(e: React.DragEvent<HTMLLabelElement>) {
		e.preventDefault();
		setDragOver(false);
		const f = e.dataTransfer.files?.[0];
		if (f) { setSelectedFile(f); setError(null); }
	}

	return (
		<div className="space-y-7">
			{!brief && (
				<div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
					<div className="px-6 pt-5 pb-3 border-b border-border">
						<h2 className="text-base font-semibold text-foreground tracking-tight">台本ドラフト (Word) を取り込む</h2>
						<p className="text-xs text-muted-foreground mt-1">
							既存の台本ドラフト (.docx) をアップロードすると、当システムの様式に整形して取り込みます。文章はそのまま保持し、構造だけ整えます。取り込み後に「改稿」で磨き込み、試験結果も確認できます。旧 .doc 形式は非対応です。
						</p>
					</div>
					<div className="p-6 space-y-4">
						<label
							htmlFor="screenplay-import-input"
							onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
							onDragLeave={() => setDragOver(false)}
							onDrop={onDropFiles}
							className={[
								"relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed py-12 cursor-pointer transition-all",
								dragOver ? "border-blue-500 bg-blue-600/10" : "border-border hover:border-blue-400 hover:bg-blue-600/10",
							].join(" ")}
						>
							<div className="relative w-14 h-14 rounded-2xl bg-card shadow-sm border border-border flex items-center justify-center">
								<Upload size={22} className="text-blue-600" />
							</div>
							<div className="relative text-sm font-medium text-foreground">
								{selectedFile ? "別のファイルに変更" : "クリックして .docx を選択 — またはドラッグ＆ドロップ"}
							</div>
							<div className="relative flex items-center gap-1.5">
								<span className="text-[10px] font-mono font-semibold tracking-wider text-muted-foreground bg-card border border-border px-1.5 py-0.5 rounded">DOCX</span>
								<span className="text-[11px] text-muted-foreground ml-1">最大 25MB</span>
							</div>
							<input
								ref={fileInputRef}
								id="screenplay-import-input"
								type="file"
								accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
								className="hidden"
								onChange={(e) => { setSelectedFile(e.target.files?.[0] ?? null); setError(null); }}
							/>
						</label>

						{selectedFile && (
							<div className="flex items-center gap-3 p-3.5 bg-muted/80 border border-border rounded-xl">
								<div className="w-9 h-9 rounded-lg bg-card border border-border flex items-center justify-center shrink-0">
									<FileText size={16} className="text-blue-500" />
								</div>
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium text-foreground truncate">{selectedFile.name}</div>
									<div className="text-[11px] text-muted-foreground tabular-nums">{formatBytes(selectedFile.size)}</div>
								</div>
								<button
									type="button"
									onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
									className="text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-card transition-colors"
									aria-label="ファイルを削除"
								>
									<X size={14} />
								</button>
							</div>
						)}

						<div className="flex items-center justify-end pt-1">
							<button
								type="button"
								onClick={runImport}
								disabled={!selectedFile || extracting}
								className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium pl-4 pr-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-blue-200/60"
							>
								{extracting ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
								{extracting ? "取り込み中..." : "取り込んで整形"}
							</button>
						</div>
					</div>
				</div>
			)}

			{brief && markdown && (
				<div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
					<div className="relative px-6 pt-5 pb-4 border-b border-border bg-gradient-to-b from-emerald-600/10 to-transparent">
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<div className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase text-emerald-700 dark:text-emerald-300 bg-emerald-600/10 border border-emerald-200/80 rounded-full px-2 py-0.5">
									<CheckCircle2 size={12} />
									取り込み完了
								</div>
								<h2 className="text-base font-semibold text-foreground tracking-tight mt-2">商品情報を確認・編集</h2>
								<p className="text-xs text-muted-foreground mt-1 max-w-xl">
									この情報は試験（コンプライアンス検査）と改稿に使われます。整形後の台本は下のプレビューで確認できます。問題なければ「この台本で開始」を押してください。
								</p>
							</div>
							<button
								type="button"
								onClick={resetAll}
								className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline shrink-0 transition-colors"
							>
								<RotateCcw size={12} />
								別のファイルで取り込み直す
							</button>
						</div>
					</div>

					<ProductBriefEditor
						brief={brief}
						onBriefChange={setBrief}
						bonusesText={bonusesText}
						onBonusesChange={setBonusesText}
						listPrice={listPrice}
						salePrice={salePrice}
						shippingPrice={shippingPrice}
						onListPrice={setListPrice}
						onSalePrice={setSalePrice}
						onShippingPrice={setShippingPrice}
					/>

					<div className="px-6 pb-6">
						<button
							type="button"
							onClick={() => setShowPreview((v) => !v)}
							className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
						>
							{showPreview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
							整形後の台本プレビュー
						</button>
						{showPreview && (
							<div className="mt-3 max-h-[480px] overflow-y-auto rounded-xl border border-border bg-muted/30 p-5">
								<ScreenplayMarkdown markdown={markdown} />
							</div>
						)}
					</div>
				</div>
			)}

			{error && (
				<div className="flex items-start gap-2.5 p-3.5 bg-red-600/10 border border-red-200/80 rounded-xl text-sm text-red-700 dark:text-red-300 shadow-sm">
					<AlertCircle size={16} className="shrink-0 mt-0.5 text-red-500" />
					<div className="leading-relaxed">{error}</div>
				</div>
			)}

			{brief && markdown && (
				<div className="sticky bottom-4 z-10">
					<div className="flex items-center justify-between gap-4 bg-card/95 backdrop-blur-md border border-border rounded-2xl shadow-lg p-4">
						<div className="min-w-0 flex-1 flex items-center gap-3">
							<div className="hidden sm:flex w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 items-center justify-center shrink-0">
								<Sparkles size={16} className="text-white" />
							</div>
							<div className="min-w-0">
								<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">取り込み対象</div>
								<div className="text-sm font-semibold text-foreground truncate mt-0.5">{brief.name || "(商品名未入力)"}</div>
								<div className="text-[11px] text-muted-foreground mt-0.5">v1 として取り込み、自動で試験を実行します（自動修正はしません）。</div>
							</div>
						</div>
						<button
							type="button"
							onClick={submit}
							disabled={!brief.name.trim() || !brief.description.trim() || submitting}
							className="inline-flex items-center gap-2 bg-gray-900 hover:bg-black text-white text-sm font-medium pl-5 pr-4 py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0 shadow-sm"
						>
							{submitting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
							{submitting ? "作成中..." : "この台本で開始"}
							{!submitting && <ArrowRight size={14} className="opacity-70" />}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 2: tsc + lint check**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/screenplay/ScreenplayImportForm.tsx
git commit -m "feat(screenplay): ScreenplayImportForm (upload + review + start)"
```

---

## Task 13: Tab switch on `/screenplays/new`

**Files:**
- Create: `components/screenplay/ScreenplayNewTabs.tsx`
- Modify: `app/[locale]/(produce)/screenplays/new/page.tsx`

- [ ] **Step 1: Create the tabs wrapper**

```tsx
"use client";
import { useState } from "react";
import { Sparkles, FileUp } from "lucide-react";
import { ScreenplayCreateForm } from "./ScreenplayCreateForm";
import { ScreenplayImportForm } from "./ScreenplayImportForm";

type Tab = "generate" | "import";

export function ScreenplayNewTabs({ locale }: { locale: string }) {
	const [tab, setTab] = useState<Tab>("generate");
	const tabs: { id: Tab; label: string; sub: string; icon: typeof Sparkles }[] = [
		{ id: "generate", label: "商品資料から生成", sub: "PDF / Excel / 画像 / URL", icon: Sparkles },
		{ id: "import", label: "台本ドラフトを取り込む", sub: "Word (.docx)", icon: FileUp },
	];
	return (
		<div className="space-y-7">
			<div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="tablist" aria-label="作成方法">
				{tabs.map((t) => {
					const Icon = t.icon;
					const active = tab === t.id;
					return (
						<button
							key={t.id}
							role="tab"
							aria-selected={active}
							onClick={() => setTab(t.id)}
							className={[
								"group text-left rounded-2xl border p-5 transition-all",
								active ? "border-blue-500 bg-blue-600/10 ring-4 ring-blue-500/10 shadow-sm" : "border-border bg-card hover:bg-muted",
							].join(" ")}
						>
							<div className="flex items-start gap-3">
								<div className={["w-10 h-10 rounded-xl flex items-center justify-center shrink-0", active ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"].join(" ")}>
									<Icon size={18} />
								</div>
								<div className="min-w-0">
									<div className="text-sm font-semibold text-foreground">{t.label}</div>
									<div className="text-xs text-muted-foreground mt-1">{t.sub}</div>
								</div>
							</div>
						</button>
					);
				})}
			</div>

			{tab === "generate" ? <ScreenplayCreateForm locale={locale} /> : <ScreenplayImportForm locale={locale} />}
		</div>
	);
}
```

- [ ] **Step 2: Render the tabs in the page**

In `app/[locale]/(produce)/screenplays/new/page.tsx`, change the import:
```tsx
import { ScreenplayCreateForm } from "@/components/screenplay/ScreenplayCreateForm";
```
to:
```tsx
import { ScreenplayNewTabs } from "@/components/screenplay/ScreenplayNewTabs";
```
And change the render:
```tsx
			<ScreenplayCreateForm locale={locale} />
```
to:
```tsx
			<ScreenplayNewTabs locale={locale} />
```

- [ ] **Step 3: tsc + lint check**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/screenplay/ScreenplayNewTabs.tsx "app/[locale]/(produce)/screenplays/new/page.tsx"
git commit -m "feat(screenplay): tab switch between generate and import on /new"
```

---

## Task 14: Import-aware `GenerationProgress`

**Files:**
- Modify: `components/screenplay/GenerationProgress.tsx`
- Modify: `components/screenplay/ScreenplayWorkspace.tsx`

- [ ] **Step 1: Add a `variant` prop to `GenerationProgress`**

In `components/screenplay/GenerationProgress.tsx`, change the `Props` interface:
```ts
interface Props {
	runId: string;
	onComplete: (versionId: string, versionNumber: number) => void;
}
```
to:
```ts
interface Props {
	runId: string;
	onComplete: (versionId: string, versionNumber: number) => void;
	variant?: "generate" | "import";
}
```
Change the function signature:
```ts
export function GenerationProgress({ runId, onComplete }: Props) {
```
to:
```ts
export function GenerationProgress({ runId, onComplete, variant = "generate" }: Props) {
```

- [ ] **Step 2: Switch the copy + hide the chunk bar for import**

In the same file, locate where `lastChunk`, `pctTarget` are computed and the JSX renders the title/subtitle/progress bar. Replace the title `<h3>` content and the subtitle `<p>` and the progress-bar block with variant-aware versions.

Replace:
```tsx
								<h3 className="text-sm font-semibold text-foreground">
									{error ? "生成に失敗しました" : doneAt ? `第 ${doneAt.versionNumber} 稿を生成しました` : "台本を生成中"}
								</h3>
```
with:
```tsx
								<h3 className="text-sm font-semibold text-foreground">
									{error
										? (variant === "import" ? "取り込みに失敗しました" : "生成に失敗しました")
										: doneAt
										? (variant === "import" ? "台本を取り込みました" : `第 ${doneAt.versionNumber} 稿を生成しました`)
										: (variant === "import" ? "台本を取り込み中" : "台本を生成中")}
								</h3>
```
Replace:
```tsx
							<p className="text-xs text-muted-foreground mt-0.5">
								{error
									? error
									: doneAt
									? "改稿フィードバックを送信すると、引き続き磨き込めます。"
									: "テレ東スタイルの台本を執筆中です。深く考えながら執筆するため、約2〜6分かかります。ページを閉じても処理は継続します。"}
							</p>
```
with:
```tsx
							<p className="text-xs text-muted-foreground mt-0.5">
								{error
									? error
									: doneAt
									? "改稿フィードバックを送信すると、引き続き磨き込めます。"
									: variant === "import"
									? "ドラフトを様式に整え、コンプライアンス試験を実行しています。"
									: "テレ東スタイルの台本を執筆中です。深く考えながら執筆するため、約2〜6分かかります。ページを閉じても処理は継続します。"}
							</p>
```
Replace the progress-bar block:
```tsx
							{!error && !doneAt && (
								<div className="mt-3">
									<div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
										<span>{chars > 0 ? `${chars.toLocaleString()} 文字を受信` : "接続中..."}</span>
										<span className="tabular-nums">{pctTarget}%</span>
									</div>
									<div className="h-1.5 bg-muted rounded-full overflow-hidden">
										<div
											className="h-full bg-blue-500 rounded-full transition-[width] duration-700 ease-out"
											style={{ width: `${Math.max(pctTarget, 5)}%` }}
										/>
									</div>
								</div>
							)}
```
with:
```tsx
							{!error && !doneAt && variant === "generate" && (
								<div className="mt-3">
									<div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
										<span>{chars > 0 ? `${chars.toLocaleString()} 文字を受信` : "接続中..."}</span>
										<span className="tabular-nums">{pctTarget}%</span>
									</div>
									<div className="h-1.5 bg-muted rounded-full overflow-hidden">
										<div
											className="h-full bg-blue-500 rounded-full transition-[width] duration-700 ease-out"
											style={{ width: `${Math.max(pctTarget, 5)}%` }}
										/>
									</div>
								</div>
							)}
							{!error && !doneAt && variant === "import" && (
								<div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
									<Loader2 size={12} className="animate-spin text-blue-600" />
									<span>
										{events.some((e) => e.type === "step" && e.name === "check" && e.status === "started")
											? "試験中..."
											: "取り込み中..."}
									</span>
								</div>
							)}
```

- [ ] **Step 3: Pass `variant` from `ScreenplayWorkspace`**

In `components/screenplay/ScreenplayWorkspace.tsx`:

(a) Derive the variant from the URL near the top of the component (after `const search = useSearchParams();`):
```tsx
	const isImport = search.get("kind") === "import";
```
(b) Pass it to `GenerationProgress` — change:
```tsx
							<GenerationProgress runId={runId} onComplete={(versionId) => handleComplete(versionId)} />
```
to:
```tsx
							<GenerationProgress runId={runId} onComplete={(versionId) => handleComplete(versionId)} variant={isImport ? "import" : "generate"} />
```

- [ ] **Step 4: tsc + lint check**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: no errors. (`Loader2` is already imported in `GenerationProgress.tsx`; `events` is already in scope.)

- [ ] **Step 5: Commit**

```bash
git add components/screenplay/GenerationProgress.tsx components/screenplay/ScreenplayWorkspace.tsx
git commit -m "feat(screenplay): import-aware progress (取り込み中 / 試験中)"
```

---

## Task 15: Full verification (build + manual walkthrough)

**Files:** none (verification only)

- [ ] **Step 1: Type-check, lint, and the import test suite**

Run:
```bash
npx tsc --noEmit && npm run lint && npm run test:screenplay-import
```
Expected: tsc clean, lint clean, `test:screenplay-import` → `11 pass, 0 fail, 0 skip` (with `.env.local` present).

- [ ] **Step 2: Production build (catches RSC/client boundary issues)**

Run:
```bash
npm run build
```
Expected: build succeeds; `/[locale]/screenplays/new` and `/api/screenplays/import` compile.

- [ ] **Step 3: Manual walkthrough (dev server)**

Run `npm run dev`, then:
1. Open `/ja/screenplays/new`. Confirm two tabs; default 「商品資料から生成」 renders the existing form unchanged.
2. Switch to 「台本ドラフトを取り込む」. Upload a `.docx` draft. Confirm the brief review + collapsible 整形後の台本プレビュー appear, and the preview renders speaker/cue blocks.
3. Try uploading a `.doc` (or a renamed non-docx) → expect the 415 message 「旧 .doc 形式は非対応です…」.
4. Click 「この台本で開始」. Confirm redirect to `/ja/screenplays/{id}?run=...&kind=import`, the progress card shows 「台本を取り込み中」 then 「試験中...」 then 「台本を取り込みました」 (no char-percent bar).
5. Confirm v1 renders, the 改稿履歴 shows 「Word ドラフト取り込み」, and the 試験結果 panel shows a score + findings. If the draft had a high-severity legal phrase, confirm it appears in red and was NOT auto-rewritten.
6. Send a 改稿 feedback → confirm a normal v2 is generated as before.

- [ ] **Step 4: Final review request**

Use the `superpowers:requesting-code-review` skill (or `/code-review`) on the branch diff before merging. Pay attention to: the workflow `import` branch (no generation path leakage), `persistCheckStep` call sites (both updated), and the `.docx` magic-byte guard.

---

## Self-Review Notes (author)

- **Spec coverage**: §6 normalize → Tasks 3/5; §6 parseImportJson → Task 3; §7 fidelity gate → Task 4; §8 import route + validation → Tasks 9/10/6; §9 workflow branch + per-run remediation → Task 8; §10 UI (ProductBriefEditor, ImportForm, tabs, progress variant) → Tasks 11–14; §11 mammoth dep → Task 1; §13 testing → Tasks 2–6 + 15. All covered.
- **Type consistency**: `parseBriefObject(obj)`, `parseImportJson(text)→{markdown,brief}`, `NormalizedDraft`, `validateImportedMarkdown(input)→{ok,error?,markdown?}`, `extractDocxText(buffer)→{text,format}`, `GenerationMode "import"`, `ScreenplayWorkflowInput.importedMarkdown`, `persistCheckStep(...,autoRemediateEnabled)`, `BriefDraft`, `GenerationProgress variant` — names match across tasks.
- **No schema changes**; reuses `screenplays`/`screenplay_versions`/`screenplay_version_checks`. v1 marked `model:"imported"`, `feedback:"Word ドラフト取り込み"`.
