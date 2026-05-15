# Screenplay Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inside the mediaworks app, let a user generate a Japanese-TV-shopping screenplay for a product, then iteratively refine it with free-text feedback (e.g. "이 특징 설명은 마지막에 넣어 주세요", "실 끼우기 시연을 넣어 주세요"); every refinement keeps a versioned history.

**Architecture:** Mirror the existing `md-strategy` feature exactly — Vercel Workflow runs a `gemini-3.1-pro-preview` call with `ThinkingLevel.HIGH`, an NDJSON stream surfaces progress, Supabase stores the screenplay and each version. The "refine with feedback" path is the same workflow re-entered with `mode: "refine"`, taking the previous version's markdown plus the new feedback as additional prompt context. The exemplar (`MIRAI-CLEAN-Pro.md`) and distilled style bible (`style_bible.json`) ship as static assets in `lib/screenplay/` — we do not bundle the 194K `all_pages.json` because the proven path uses the distilled bible + one exemplar (every attempt to include `all_pages.json` in a single Gemini call has timed out).

**Tech Stack:** Next.js 16.1.6 App Router · React 19 · TypeScript 5 · Tailwind v4 · shadcn/ui · Supabase Postgres (service-role) · `@google/genai` ≥ 1.48 · `workflow` (Vercel) · `next-intl` v4 · Lucide React

**Output format decisions:**
- Markdown stored in DB (the renderer styles `[テロップ]`, `[カメラ]`, `[BGM]`, `[SE]` blocks)
- **No SVG, no figures** — purely text descriptions of production
- Target length: 30k–60k characters per version (matches `screenplay_MIRAI-CLEAN-Pro.md` density)
- Language inside the screenplay: Japanese only (English UI labels for the surrounding chrome)

**Reference: confirmed-working assets to copy into the repo (verbatim, then commit):**
- `/Users/kjyoo/jp-script/output/style_bible.json` → `lib/screenplay/style-bible.json`
- `/Users/kjyoo/jp-script/output/screenplay_MIRAI-CLEAN-Pro.md` → `lib/screenplay/exemplar.md`

---

## File Structure

**Create:**
- `supabase/migrations/2026-05-13_screenplays.sql`
- `lib/screenplay/style-bible.json` *(static asset, copied)*
- `lib/screenplay/exemplar.md` *(static asset, copied)*
- `lib/screenplay/types.ts` *(TypeScript types)*
- `lib/screenplay/generator.ts` *(Gemini call wrapper, mirrors `lib/md-strategy.ts` patterns)*
- `lib/screenplay/prompt.ts` *(prompt assembly — initial vs refine)*
- `lib/workflows/screenplay.workflow.ts` *(Vercel Workflow, mirrors `md-strategy.workflow.ts`)*
- `app/api/screenplays/route.ts` *(GET list, POST create)*
- `app/api/screenplays/[id]/route.ts` *(GET one + DELETE)*
- `app/api/screenplays/[id]/refine/route.ts` *(POST refine with feedback)*
- `app/api/screenplays/run/[runId]/stream/route.ts` *(NDJSON progress)*
- `app/api/screenplays/run/[runId]/status/route.ts` *(status fallback)*
- `components/screenplay/ScreenplayList.tsx`
- `components/screenplay/ScreenplayCreateForm.tsx`
- `components/screenplay/ScreenplayViewer.tsx`
- `components/screenplay/VersionTimeline.tsx`
- `components/screenplay/FeedbackForm.tsx`
- `components/screenplay/GenerationProgress.tsx`
- `components/screenplay/markdown-renderer.tsx` *(custom MD → React, styles テロップ/カメラ blocks)*
- `app/[locale]/screenplays/page.tsx` *(list)*
- `app/[locale]/screenplays/new/page.tsx` *(create form)*
- `app/[locale]/screenplays/[id]/page.tsx` *(detail + iteration UI)*
- `scripts/test-screenplay-generator.ts` *(smoke test)*
- `messages/ko.json` *(Korean — missing today)*

**Modify:**
- `messages/ja.json` *(add `screenplay.*` keys)*
- `messages/en.json` *(add `screenplay.*` keys)*
- `i18n.ts` *(register `ko` locale if not already)*
- `components/Navbar.tsx` *(add `Screenplays` nav link)*
- `package.json` *(add `test:screenplay` script)*

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/2026-05-13_screenplays.sql`

- [ ] **Step 1: Author the migration**

```sql
-- supabase/migrations/2026-05-13_screenplays.sql
-- Screenplays + versioned iterations with user feedback.

create table if not exists screenplays (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  title text not null,
  product_info_snapshot jsonb not null,       -- frozen product spec at first gen
  current_version_id uuid,                    -- FK populated after versions row exists
  status text not null default 'pending'      -- pending | generating | ready | failed
    check (status in ('pending','generating','ready','failed')),
  last_run_id text,                            -- workflow runId of the most recent generation
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists screenplay_versions (
  id uuid primary key default gen_random_uuid(),
  screenplay_id uuid not null references screenplays(id) on delete cascade,
  version_number int not null,
  markdown text not null,
  feedback text,                                -- null for v1; user's refinement request for v2+
  base_version_id uuid references screenplay_versions(id) on delete set null,
  model text not null,                          -- e.g. 'gemini-3.1-pro-preview'
  thinking_level text not null,                 -- 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL'
  token_usage jsonb,
  created_at timestamptz not null default now(),
  unique (screenplay_id, version_number)
);

alter table screenplays
  add constraint screenplays_current_version_fk
    foreign key (current_version_id)
    references screenplay_versions(id)
    on delete set null;

create index if not exists screenplays_created_at_idx on screenplays(created_at desc);
create index if not exists screenplay_versions_screenplay_id_idx on screenplay_versions(screenplay_id, version_number);
```

- [ ] **Step 2: Apply locally via Supabase CLI**

Run: `npx supabase db push` (or whatever the team uses — confirm by inspecting other migrations' commit history)
Expected: migration applies, both tables visible in Supabase dashboard.

- [ ] **Step 3: Regenerate Supabase types if the repo does that**

Look at `lib/supabase.ts` — if types are hand-rolled there, append `Screenplay` and `ScreenplayVersion` types matching the columns above (mirror the style of existing type exports in that file). Skip if types are auto-generated.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-13_screenplays.sql lib/supabase.ts
git commit -m "feat(screenplays): add screenplays + versions tables"
```

---

## Task 2: Bundle static assets

**Files:**
- Create: `lib/screenplay/style-bible.json`
- Create: `lib/screenplay/exemplar.md`

- [ ] **Step 1: Copy the proven style bible**

```bash
cp /Users/kjyoo/jp-script/output/style_bible.json /Users/kjyoo/mediaworks/lib/screenplay/style-bible.json
```

Expected: file is ~21K, contains keys `show_profile`, `macro_structure`, `speaker_roles`, `writing_style_dna`, `persuasion_playbook`, `visual_and_demo_conventions`, `page_layout_conventions`, `generation_template`, `evidence_index`.

- [ ] **Step 2: Copy the exemplar screenplay**

```bash
cp /Users/kjyoo/jp-script/output/screenplay_MIRAI-CLEAN-Pro.md /Users/kjyoo/mediaworks/lib/screenplay/exemplar.md
```

Expected: file is ~14K markdown, contains the exact section order we want the model to follow (アバン → スタジオ①〜④ → CTA1 → VTR テスティモニアル → CTA2).

- [ ] **Step 3: Commit**

```bash
git add lib/screenplay/style-bible.json lib/screenplay/exemplar.md
git commit -m "feat(screenplays): bundle style-bible and exemplar"
```

---

## Task 3: Types module

**Files:**
- Create: `lib/screenplay/types.ts`

- [ ] **Step 1: Write the types**

```ts
// lib/screenplay/types.ts
export type GenerationMode = "initial" | "refine";

export type ProgressEvent =
  | { type: "step"; name: string; status: "started" | "completed" | "failed"; detail?: string }
  | { type: "chunk"; chars: number }
  | { type: "done"; screenplayId: string; versionId: string; versionNumber: number }
  | { type: "error"; message: string };

export interface ProductBrief {
  name: string;
  category?: string;
  description: string;            // free-form: features, materials, target user, etc.
  price?: { listJpy?: number; saleJpy?: number; shippingJpy?: number };
  bonuses?: string[];
  guarantee?: string;
  notes?: string;                  // anything else the user pasted
}

export interface GenerateInput {
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;               // refine only
  previousMarkdown?: string;       // refine only — the version being iterated on
}

export interface GenerationResult {
  markdown: string;
  model: string;
  thinkingLevel: string;
  tokenUsage?: { input?: number; output?: number };
}

export interface ScreenplayRow {
  id: string;
  product_id: string | null;
  title: string;
  product_info_snapshot: ProductBrief;
  current_version_id: string | null;
  status: "pending" | "generating" | "ready" | "failed";
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScreenplayVersionRow {
  id: string;
  screenplay_id: string;
  version_number: number;
  markdown: string;
  feedback: string | null;
  base_version_id: string | null;
  model: string;
  thinking_level: string;
  token_usage: { input?: number; output?: number } | null;
  created_at: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/screenplay/types.ts
git commit -m "feat(screenplays): add type definitions"
```

---

## Task 4: Prompt assembly

**Files:**
- Create: `lib/screenplay/prompt.ts`

- [ ] **Step 1: Write the prompt builder**

```ts
// lib/screenplay/prompt.ts
import fs from "node:fs/promises";
import path from "node:path";
import type { GenerateInput, ProductBrief } from "./types";

const STYLE_BIBLE_PATH = path.join(process.cwd(), "lib/screenplay/style-bible.json");
const EXEMPLAR_PATH = path.join(process.cwd(), "lib/screenplay/exemplar.md");

let _styleBible: string | null = null;
let _exemplar: string | null = null;

async function loadAssets(): Promise<{ styleBible: string; exemplar: string }> {
  if (!_styleBible) _styleBible = await fs.readFile(STYLE_BIBLE_PATH, "utf-8");
  if (!_exemplar) _exemplar = await fs.readFile(EXEMPLAR_PATH, "utf-8");
  return { styleBible: _styleBible, exemplar: _exemplar };
}

function formatProductBrief(b: ProductBrief): string {
  const lines: string[] = [];
  lines.push(`商品名: ${b.name}`);
  if (b.category) lines.push(`カテゴリ: ${b.category}`);
  lines.push("");
  lines.push("特徴・スペック:");
  lines.push(b.description);
  if (b.price) {
    lines.push("");
    lines.push("価格情報:");
    if (b.price.listJpy) lines.push(`  メーカー直販価格: ¥${b.price.listJpy.toLocaleString()}`);
    if (b.price.saleJpy) lines.push(`  本日特別価格: ¥${b.price.saleJpy.toLocaleString()}`);
    if (b.price.shippingJpy != null) lines.push(`  送料: ¥${b.price.shippingJpy.toLocaleString()}`);
  }
  if (b.bonuses?.length) {
    lines.push("");
    lines.push("ボーナス・特典:");
    for (const b1 of b.bonuses) lines.push(`  - ${b1}`);
  }
  if (b.guarantee) lines.push("", `保証: ${b.guarantee}`);
  if (b.notes) lines.push("", "その他のメモ:", b.notes);
  return lines.join("\n");
}

export async function buildPrompt(input: GenerateInput): Promise<string> {
  const { styleBible, exemplar } = await loadAssets();
  const productBlock = formatProductBrief(input.productBrief);

  const sharedRules = `
あなたはテレビ東京系「生活情報マーケット (テレ東ダイレクト)」のチーフ放送作家です。
完成版テレビショッピング台本を Markdown で書く。【参考台本】と同じセクション構成・同じ密度・同じ書式で。

【必ず守るセクション順】
1. \`# {商品名} — テレビショッピング 台本\`
2. \`## メタ情報\` （商品名 / カテゴリ / 推定放送尺 / ターゲット視聴者 / キー・メッセージ）
3. \`## 構成 (Act-by-Act Outline)\`
4. \`## 本編 (Full Script)\` の中に **この順で**：
   - \`### ■アバン (The Hook & Problem Setup)\`
   - \`### ■スタジオ① (Studio Intro & Contrast)\`
   - \`### ■スタジオ② (The Live Demonstrations)\`
   - \`### ■スタジオ③ (Objection Handling & Versatility)\`
   - \`### ■スタジオ④ (The Offer & Price Reveal)\`
   - \`### ■CTA 1 (テレホンアタック 25秒)\`
   - \`### ■VTR テスティモニアル (VTR / お客様)\`
   - \`### ■CTA 2 (テレホンアタック リフレイン 15秒)\`
5. \`## 価格 & オファー (Pricing & Offer Sheet)\` (Markdownテーブル)
6. \`## スタイル・コンプライアンス・ノート\`

【書式】
- 役名は \`[N]\` ナレーター / \`[高橋]\` 商品アドバイザー / \`[山内]\` MC（驚き役） / \`[小島]\` MC（共感役） / \`[お客様]\`
- 役名の後に \`(感情・演出メモ in English)\` を1行
- 直下に日本語セリフ → その下のかっこ内に英訳 1行
- 演出キュー: \`[テロップ]\`, \`[カメラ]\`, \`[BGM]\`, \`[SE]\`
- テロップ箇条書きは ○ ● ※ の3階層（必須）
- アクト境界は \`---\` で区切る
- **SVG・図・画像タグ一切禁止。視覚情報はテキストとテロップで表現。**
- 不必要な情報（JANコード、梱包サイズ、お手入れ等）はカット。

【密度】参考台本と同等以上。各アクトに最低3〜5の演出キュー、複数の話者ライン。
`.trim();

  if (input.mode === "initial") {
    return [
      sharedRules,
      "",
      "---",
      "",
      "【参考台本（MIRAI-CLEAN Pro）— 構成・密度・書式を厳密に模倣】",
      "",
      exemplar,
      "",
      "---",
      "",
      "【商品情報】",
      "",
      productBlock,
      "",
      "---",
      "",
      "【style_bible 抜粋】",
      "",
      styleBible.slice(0, 8000),
      "",
      "---",
      "",
      "【出力】完成版 Markdown 台本のみ。前後の説明・コードフェンス禁止。",
    ].join("\n");
  }

  // refine mode
  const feedback = input.feedback?.trim();
  const previous = input.previousMarkdown?.trim();
  if (!feedback) throw new Error("refine mode requires feedback");
  if (!previous) throw new Error("refine mode requires previousMarkdown");
  return [
    sharedRules,
    "",
    "---",
    "",
    "【現在の台本（このバージョンをベースに改稿）】",
    "",
    previous,
    "",
    "---",
    "",
    "【ディレクターからのフィードバック — このフィードバックを最優先で反映】",
    "",
    feedback,
    "",
    "---",
    "",
    "【商品情報】",
    "",
    productBlock,
    "",
    "---",
    "",
    "【style_bible 抜粋】",
    "",
    styleBible.slice(0, 6000),
    "",
    "---",
    "",
    "【出力】",
    "フィードバックを反映した、全セクション込みの完成版 Markdown 台本のみを出力。",
    "差分ではなく完全版。前後の説明・コードフェンス禁止。",
    "フィードバックで言及されなかった他のセクションは前バージョンを尊重しつつ、自然な流れになるよう微調整は許容。",
  ].join("\n");
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/screenplay/prompt.ts
git commit -m "feat(screenplays): prompt assembly for initial + refine"
```

---

## Task 5: Generator (Gemini call wrapper)

**Files:**
- Create: `lib/screenplay/generator.ts`

- [ ] **Step 1: Write the generator**

```ts
// lib/screenplay/generator.ts
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { buildPrompt } from "./prompt";
import type { GenerateInput, GenerationResult } from "./types";

// Lazy SDK init — matches md-strategy.ts pattern (workflow sandbox safety).
let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return _genAI;
}

// Gemini 3.1 Pro preview with HIGH thinking. Empirically: 60-180s per call,
// occasionally up to 4 min. Match md-strategy's timeouts.
const HARD_TIMEOUT_MS = 360_000;     // 6 min — Pro+HIGH worst case
const FIRST_CHUNK_MS = 180_000;      // 3 min — Pro+HIGH server-side thinking
const MODEL = "gemini-3.1-pro-preview";

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes("503") || m.includes("429") || m.includes("500") ||
    m.includes("502") || m.includes("504") ||
    m.includes("overloaded") || m.includes("UNAVAILABLE") ||
    m.includes("aborted") || m.includes("timeout") ||
    m.includes("ECONNRESET") || m.includes("ETIMEDOUT")
  );
}

async function callOnce(prompt: string, onChunk?: (chars: number) => void): Promise<string> {
  const controller = new AbortController();
  const hardTimer = setTimeout(
    () => controller.abort(new Error(`Gemini hard timeout ${HARD_TIMEOUT_MS}ms`)),
    HARD_TIMEOUT_MS,
  );
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => controller.abort(new Error(`Gemini first-chunk timeout ${FIRST_CHUNK_MS}ms`)),
    FIRST_CHUNK_MS,
  );
  try {
    const stream = await getGenAI().models.generateContentStream({
      model: MODEL,
      contents: prompt,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        abortSignal: controller.signal,
      },
    });
    let text = "";
    for await (const chunk of stream) {
      if (firstChunkTimer) {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = null;
      }
      const t = chunk.text ?? "";
      text += t;
      onChunk?.(text.length);
    }
    return text;
  } finally {
    clearTimeout(hardTimer);
    if (firstChunkTimer) clearTimeout(firstChunkTimer);
  }
}

export async function generateScreenplay(
  input: GenerateInput,
  onChunk?: (chars: number) => void,
): Promise<GenerationResult> {
  const prompt = await buildPrompt(input);
  const ATTEMPTS = 3;
  let lastErr: unknown;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const raw = await callOnce(prompt, onChunk);
      // Strip any stray code fence the model might add.
      let md = raw.trim();
      const fence = md.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
      if (fence) md = fence[1].trim();
      if (md.length < 1000) throw new Error(`output suspiciously short: ${md.length} chars`);
      return {
        markdown: md,
        model: MODEL,
        thinkingLevel: "HIGH",
      };
    } catch (err) {
      lastErr = err;
      if (i === ATTEMPTS || !isRetryable(err)) throw err;
      const delay = 4000 * i;
      console.warn(`[screenplay] attempt ${i}/${ATTEMPTS} failed: ${(err as Error).message} — waiting ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/screenplay/generator.ts
git commit -m "feat(screenplays): Gemini Pro 3.1 generator with retry"
```

---

## Task 6: Vercel Workflow

**Files:**
- Create: `lib/workflows/screenplay.workflow.ts`

- [ ] **Step 1: Write the workflow**

```ts
// lib/workflows/screenplay.workflow.ts
import { getWritable, FatalError } from "workflow";
import { generateScreenplay } from "@/lib/screenplay/generator";
import { getServiceClient } from "@/lib/supabase";
import type {
  GenerationMode,
  ProductBrief,
  ProgressEvent,
  ScreenplayVersionRow,
} from "@/lib/screenplay/types";

export interface ScreenplayWorkflowInput {
  screenplayId: string;             // pre-created row in `screenplays`
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;                 // refine only
  baseVersionId?: string;            // refine only — version being iterated on
}

export interface ScreenplayWorkflowOutput {
  screenplayId: string;
  versionId: string;
  versionNumber: number;
}

async function loadPreviousMarkdownStep(baseVersionId: string): Promise<string> {
  "use step";
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("screenplay_versions")
    .select("markdown")
    .eq("id", baseVersionId)
    .single();
  if (error || !data) throw new FatalError(`base version not found: ${baseVersionId}`);
  return data.markdown as string;
}

async function generateStep(
  input: ScreenplayWorkflowInput,
  previousMarkdown: string | undefined,
): Promise<{ markdown: string; model: string; thinkingLevel: string }> {
  "use step";
  const progress = getWritable<ProgressEvent>({ namespace: "progress" });
  await progress.write({ type: "step", name: "generate", status: "started" });
  try {
    const result = await generateScreenplay(
      {
        mode: input.mode,
        productBrief: input.productBrief,
        feedback: input.feedback,
        previousMarkdown,
      },
      (chars) => { void progress.write({ type: "chunk", chars }); },
    );
    await progress.write({ type: "step", name: "generate", status: "completed" });
    return { markdown: result.markdown, model: result.model, thinkingLevel: result.thinkingLevel };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await progress.write({ type: "step", name: "generate", status: "failed", detail: msg });
    throw err;
  }
}

async function persistStep(
  screenplayId: string,
  markdown: string,
  feedback: string | undefined,
  baseVersionId: string | undefined,
  model: string,
  thinkingLevel: string,
): Promise<{ versionId: string; versionNumber: number }> {
  "use step";
  const supabase = getServiceClient();

  // Next version number = current max + 1
  const { data: existing } = await supabase
    .from("screenplay_versions")
    .select("version_number")
    .eq("screenplay_id", screenplayId)
    .order("version_number", { ascending: false })
    .limit(1);
  const nextVersion = (existing?.[0]?.version_number ?? 0) + 1;

  const { data: inserted, error: insErr } = await supabase
    .from("screenplay_versions")
    .insert({
      screenplay_id: screenplayId,
      version_number: nextVersion,
      markdown,
      feedback: feedback ?? null,
      base_version_id: baseVersionId ?? null,
      model,
      thinking_level: thinkingLevel,
    })
    .select("id, version_number")
    .single();
  if (insErr || !inserted) throw new FatalError(`failed to insert version: ${insErr?.message}`);

  const versionRow = inserted as Pick<ScreenplayVersionRow, "id" | "version_number">;

  // Promote this version to current.
  const { error: updErr } = await supabase
    .from("screenplays")
    .update({
      current_version_id: versionRow.id,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", screenplayId);
  if (updErr) throw new FatalError(`failed to update screenplay: ${updErr.message}`);

  return { versionId: versionRow.id, versionNumber: versionRow.version_number };
}

export async function screenplayWorkflow(
  input: ScreenplayWorkflowInput,
): Promise<ScreenplayWorkflowOutput> {
  const progress = getWritable<ProgressEvent>({ namespace: "progress" });
  try {
    let previousMarkdown: string | undefined;
    if (input.mode === "refine") {
      if (!input.baseVersionId) throw new FatalError("refine mode requires baseVersionId");
      previousMarkdown = await loadPreviousMarkdownStep(input.baseVersionId);
    }

    const gen = await generateStep(input, previousMarkdown);
    const persisted = await persistStep(
      input.screenplayId,
      gen.markdown,
      input.feedback,
      input.baseVersionId,
      gen.model,
      gen.thinkingLevel,
    );

    await progress.write({
      type: "done",
      screenplayId: input.screenplayId,
      versionId: persisted.versionId,
      versionNumber: persisted.versionNumber,
    });
    return { screenplayId: input.screenplayId, ...persisted };
  } catch (err) {
    // Mark screenplay failed for UI display.
    const supabase = getServiceClient();
    await supabase
      .from("screenplays")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", input.screenplayId);
    const msg = err instanceof Error ? err.message : String(err);
    await progress.write({ type: "error", message: msg });
    throw err;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/workflows/screenplay.workflow.ts
git commit -m "feat(screenplays): durable workflow with progress events"
```

---

## Task 7: API — create + list (`/api/screenplays/route.ts`)

**Files:**
- Create: `app/api/screenplays/route.ts`

- [ ] **Step 1: Write the route**

```ts
// app/api/screenplays/route.ts
import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { getServiceClient } from "@/lib/supabase";
import { screenplayWorkflow } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 60;

export async function GET() {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("screenplays")
    .select("id, title, status, current_version_id, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ screenplays: data ?? [] });
}

function isProductBrief(x: unknown): x is ProductBrief {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.description === "string";
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  if (!isProductBrief(body.productBrief)) {
    return Response.json({ error: "productBrief.name + productBrief.description required" }, { status: 400 });
  }
  const productBrief: ProductBrief = body.productBrief;
  const productId: string | null = typeof body.productId === "string" ? body.productId : null;

  const supabase = getServiceClient();
  const { data: inserted, error: insErr } = await supabase
    .from("screenplays")
    .insert({
      product_id: productId,
      title: productBrief.name,
      product_info_snapshot: productBrief,
      status: "generating",
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return Response.json({ error: insErr?.message ?? "failed to create" }, { status: 500 });
  }
  const screenplayId = inserted.id as string;

  try {
    const run = await start(screenplayWorkflow, [{
      screenplayId,
      mode: "initial",
      productBrief,
    }]);
    // record runId
    await supabase
      .from("screenplays")
      .update({ last_run_id: run.runId })
      .eq("id", screenplayId);
    return Response.json({ id: screenplayId, runId: run.runId });
  } catch (err) {
    await supabase
      .from("screenplays")
      .update({ status: "failed" })
      .eq("id", screenplayId);
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/screenplays/route.ts
git commit -m "feat(screenplays): POST create + GET list endpoints"
```

---

## Task 8: API — single screenplay (`/api/screenplays/[id]/route.ts`)

**Files:**
- Create: `app/api/screenplays/[id]/route.ts`

- [ ] **Step 1: Write the route**

```ts
// app/api/screenplays/[id]/route.ts
import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 30;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = getServiceClient();

  const { data: screenplay, error: spErr } = await supabase
    .from("screenplays")
    .select("*")
    .eq("id", id)
    .single();
  if (spErr || !screenplay) {
    return Response.json({ error: spErr?.message ?? "Not found" }, { status: 404 });
  }

  const { data: versions, error: vErr } = await supabase
    .from("screenplay_versions")
    .select("id, version_number, markdown, feedback, base_version_id, model, thinking_level, created_at")
    .eq("screenplay_id", id)
    .order("version_number", { ascending: true });
  if (vErr) {
    return Response.json({ error: vErr.message }, { status: 500 });
  }

  return Response.json({ screenplay, versions: versions ?? [] });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = getServiceClient();
  const { error } = await supabase.from("screenplays").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/screenplays/[id]/route.ts
git commit -m "feat(screenplays): GET one + DELETE endpoints"
```

---

## Task 9: API — refine (`/api/screenplays/[id]/refine/route.ts`)

**Files:**
- Create: `app/api/screenplays/[id]/refine/route.ts`

- [ ] **Step 1: Write the route**

```ts
// app/api/screenplays/[id]/refine/route.ts
import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { getServiceClient } from "@/lib/supabase";
import { screenplayWorkflow } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const feedback: string = typeof body.feedback === "string" ? body.feedback.trim() : "";
  if (!feedback) {
    return Response.json({ error: "feedback (non-empty) required" }, { status: 400 });
  }
  const baseVersionId: string | undefined =
    typeof body.baseVersionId === "string" ? body.baseVersionId : undefined;

  const supabase = getServiceClient();
  const { data: sp, error: spErr } = await supabase
    .from("screenplays")
    .select("id, product_info_snapshot, current_version_id, status")
    .eq("id", id)
    .single();
  if (spErr || !sp) {
    return Response.json({ error: spErr?.message ?? "Not found" }, { status: 404 });
  }
  const base = baseVersionId ?? sp.current_version_id;
  if (!base) {
    return Response.json({ error: "no base version to refine from" }, { status: 400 });
  }

  await supabase
    .from("screenplays")
    .update({ status: "generating" })
    .eq("id", id);

  try {
    const run = await start(screenplayWorkflow, [{
      screenplayId: id,
      mode: "refine",
      productBrief: sp.product_info_snapshot as ProductBrief,
      feedback,
      baseVersionId: base,
    }]);
    await supabase
      .from("screenplays")
      .update({ last_run_id: run.runId })
      .eq("id", id);
    return Response.json({ runId: run.runId });
  } catch (err) {
    await supabase
      .from("screenplays")
      .update({ status: "failed" })
      .eq("id", id);
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/screenplays/[id]/refine/route.ts
git commit -m "feat(screenplays): POST refine endpoint"
```

---

## Task 10: API — workflow stream + status

**Files:**
- Create: `app/api/screenplays/run/[runId]/stream/route.ts`
- Create: `app/api/screenplays/run/[runId]/status/route.ts`

- [ ] **Step 1: Write the NDJSON stream route**

```ts
// app/api/screenplays/run/[runId]/stream/route.ts
import { NextRequest } from "next/server";
import { getRun } from "workflow/api";
import type { ProgressEvent } from "@/lib/screenplay/types";

// Pro+HIGH thinking can run up to ~6 min; client connection should survive that.
export const maxDuration = 800;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const run = getRun(runId);
  const source = run.getReadable<ProgressEvent>({ namespace: "progress" });
  const encoder = new TextEncoder();
  const ndjson = source.pipeThrough(
    new TransformStream<ProgressEvent, Uint8Array>({
      transform(event, controller) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      },
    }),
  );
  return new Response(ndjson, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 2: Write the status fallback route**

```ts
// app/api/screenplays/run/[runId]/status/route.ts
import { NextRequest } from "next/server";
import { getRun } from "workflow/api";

export const maxDuration = 30;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  try {
    const run = getRun(runId);
    const status = await run.status;
    if (status === "completed") {
      const returnValue = await run.returnValue as
        | { screenplayId?: string; versionId?: string; versionNumber?: number }
        | undefined;
      return Response.json({ status, returnValue });
    }
    return Response.json({ status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ status: "unknown", error: message }, { status: 404 });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/screenplays/run
git commit -m "feat(screenplays): NDJSON stream + status fallback"
```

---

## Task 11: Markdown renderer component

**Files:**
- Create: `components/screenplay/markdown-renderer.tsx`

- [ ] **Step 1: Write the renderer**

```tsx
// components/screenplay/markdown-renderer.tsx
// Server Component. Takes screenplay markdown and renders it as a structured
// React tree, styling [テロップ] / [カメラ] / [BGM] / [SE] / role-tagged lines
// distinctly. No external markdown lib — the screenplay format is regular enough
// that a hand-rolled parser is more accurate than passing through a generic MD lib.
import React from "react";

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "hr" }
  | { kind: "cue"; tag: string; lines: string[] }
  | { kind: "speaker"; role: string; delivery?: string; jp: string; en?: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "para"; text: string };

const ROLE_LABELS: Record<string, string> = {
  "N": "ナレーター",
  "高橋": "商品アドバイザー",
  "山内": "MC (驚き役)",
  "小島": "MC (共感役)",
  "お客様": "お客様",
};

function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (!trimmed) { i++; continue; }

    // Heading
    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length as 1 | 2 | 3, text: h[2] });
      i++; continue;
    }

    // HR
    if (/^---+$/.test(trimmed)) { blocks.push({ kind: "hr" }); i++; continue; }

    // Cue: [テロップ] / [カメラ] / [BGM] / [SE]
    const cue = trimmed.match(/^\[([^\]]+)\]$/);
    if (cue) {
      const tag = cue[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() && !lines[i].match(/^\[([^\]]+)\]$/) && !lines[i].match(/^#{1,3}\s/) && !/^---+$/.test(lines[i].trim())) {
        // stop if we hit a speaker tag too
        if (/^\[[一-龥A-Za-zＡ-Ｚぁ-んァ-ン]+\]/.test(lines[i].trim()) && !lines[i].includes("テロップ") && !lines[i].includes("カメラ") && !lines[i].includes("BGM") && !lines[i].includes("SE")) break;
        body.push(lines[i].trim());
        i++;
      }
      blocks.push({ kind: "cue", tag, lines: body });
      continue;
    }

    // Speaker: [N] (delivery)  followed by jp then (en)
    const spk = trimmed.match(/^\[([^\]]+)\]\s*(\(.+\))?\s*$/);
    if (spk && /^[NA-Zぁ-んァ-ン一-龥お客様高橋山内小島]+$/.test(spk[1].replace(/[　\s]/g, ""))) {
      const role = spk[1];
      const delivery = spk[2]?.replace(/^\(|\)$/g, "");
      i++;
      const jp = (lines[i] ?? "").trim();
      i++;
      let en: string | undefined;
      if ((lines[i] ?? "").trim().startsWith("(")) {
        en = lines[i].trim().replace(/^\(|\)$/g, "");
        i++;
      }
      blocks.push({ kind: "speaker", role, delivery, jp, en });
      continue;
    }

    // Table: | a | b | followed by | --- |
    if (trimmed.startsWith("|") && (lines[i + 1] ?? "").trim().startsWith("|") && /^\|[\s:|-]+\|$/.test((lines[i + 1] ?? "").trim())) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!/^[:\-\s]+$/.test(cells.join(""))) rows.push(cells);
        i++;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }

    // Bullet list
    if (/^[-*●○※]\s+/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && (/^[-*●○※]\s+/.test(lines[i].trim()) || /^\d+\.\s/.test(lines[i].trim()))) {
        items.push(lines[i].trim().replace(/^[-*●○※]\s+|^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }

    // Paragraph
    blocks.push({ kind: "para", text: trimmed });
    i++;
  }
  return blocks;
}

const cueClasses: Record<string, string> = {
  "テロップ": "border-l-4 border-zinc-900 bg-zinc-50",
  "カメラ": "border-l-4 border-zinc-600 bg-zinc-50",
  "BGM": "border-l-4 border-zinc-500 bg-zinc-50",
  "SE": "border-l-4 border-zinc-500 bg-zinc-50",
  "インサート": "border-l-4 border-zinc-700 bg-zinc-50",
  "小道具": "border-l-4 border-zinc-400 bg-zinc-50",
};

export function ScreenplayMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  return (
    <article className="prose prose-zinc max-w-none font-[var(--font-noto-sans-jp,sans-serif)] text-zinc-900">
      {blocks.map((b, idx) => {
        if (b.kind === "heading") {
          if (b.level === 1) return <h1 key={idx} className="text-3xl font-black tracking-tight mb-4">{b.text}</h1>;
          if (b.level === 2) return <h2 key={idx} className="text-xl font-bold border-b border-zinc-900 pb-2 mt-10 mb-4">{b.text}</h2>;
          return <h3 key={idx} className="text-base font-bold border-l-4 border-zinc-900 pl-2 mt-6 mb-2">{b.text}</h3>;
        }
        if (b.kind === "hr") return <hr key={idx} className="my-8 border-zinc-300" />;
        if (b.kind === "cue") {
          const cls = cueClasses[b.tag] ?? "border-l-4 border-zinc-300 bg-zinc-50";
          return (
            <div key={idx} className={`${cls} px-3 py-2 my-3 text-sm`}>
              <div className="font-bold tracking-wide text-xs uppercase mb-1">[{b.tag}]</div>
              {b.lines.map((l, li) => <div key={li} className="text-zinc-700">{l}</div>)}
            </div>
          );
        }
        if (b.kind === "speaker") {
          return (
            <div key={idx} className="grid grid-cols-[180px_1fr] gap-3 py-2 border-b border-dotted border-zinc-200">
              <div className="text-sm font-bold">
                {b.role}
                <div className="text-[10px] font-light text-zinc-500">{ROLE_LABELS[b.role] ?? ""}</div>
              </div>
              <div>
                {b.delivery && <div className="text-[11px] font-light text-zinc-500 mb-1">({b.delivery})</div>}
                <p className="text-[15px] leading-[1.85]">{b.jp}</p>
                {b.en && <p className="text-[11px] text-zinc-400 mt-1">({b.en})</p>}
              </div>
            </div>
          );
        }
        if (b.kind === "list") {
          return (
            <ul key={idx} className="my-3 pl-0">
              {b.items.map((it, ii) => <li key={ii} className="list-none text-sm">{it}</li>)}
            </ul>
          );
        }
        if (b.kind === "table") {
          const [head, ...body] = b.rows;
          return (
            <table key={idx} className="w-full border-collapse my-4 text-sm">
              <thead>
                <tr>{head.map((c, ci) => <th key={ci} className="border border-zinc-200 px-3 py-2 bg-zinc-50 text-left font-bold">{c}</th>)}</tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri}>{row.map((c, ci) => <td key={ci} className="border border-zinc-200 px-3 py-2 align-top">{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          );
        }
        return <p key={idx} className="text-[15px] leading-[1.85] my-2">{b.text}</p>;
      })}
    </article>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/screenplay/markdown-renderer.tsx
git commit -m "feat(screenplays): markdown renderer with テロップ/カメラ/role styling"
```

---

## Task 12: Generation progress component (NDJSON consumer)

**Files:**
- Create: `components/screenplay/GenerationProgress.tsx`

- [ ] **Step 1: Write the client component**

```tsx
// components/screenplay/GenerationProgress.tsx
"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import type { ProgressEvent } from "@/lib/screenplay/types";

interface Props {
  runId: string;
  onComplete: (versionId: string, versionNumber: number) => void;
}

export function GenerationProgress({ runId, onComplete }: Props) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<{ versionId: string; versionNumber: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function consume() {
      try {
        const res = await fetch(`/api/screenplays/run/${runId}/stream`, { signal: controller.signal });
        if (!res.body) throw new Error("no stream body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
              const ev = JSON.parse(t) as ProgressEvent;
              if (cancelled) return;
              setEvents((prev) => [...prev, ev]);
              if (ev.type === "done") {
                setDoneAt({ versionId: ev.versionId, versionNumber: ev.versionNumber });
                onComplete(ev.versionId, ev.versionNumber);
              } else if (ev.type === "error") {
                setError(ev.message);
              }
            } catch {
              // ignore malformed lines
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Fall back to status polling
        try {
          for (let i = 0; i < 60 && !cancelled; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            const sr = await fetch(`/api/screenplays/run/${runId}/status`);
            if (!sr.ok) continue;
            const sj = await sr.json() as { status: string; returnValue?: { versionId: string; versionNumber: number } };
            if (sj.status === "completed" && sj.returnValue) {
              setDoneAt({ versionId: sj.returnValue.versionId, versionNumber: sj.returnValue.versionNumber });
              onComplete(sj.returnValue.versionId, sj.returnValue.versionNumber);
              return;
            }
            if (sj.status === "failed") { setError("workflow failed"); return; }
          }
          setError(`stream lost: ${msg}`);
        } catch (fallbackErr) {
          setError(`stream lost: ${msg} / fallback failed: ${fallbackErr}`);
        }
      }
    }
    void consume();
    return () => { cancelled = true; controller.abort(); };
  }, [runId, onComplete]);

  const lastChunk = [...events].reverse().find((e) => e.type === "chunk") as { type: "chunk"; chars: number } | undefined;
  const lastStep = [...events].reverse().find((e) => e.type === "step") as { type: "step"; name: string; status: string } | undefined;

  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-4 flex items-start gap-3">
      {error ? (
        <AlertTriangle className="h-5 w-5 text-zinc-700 mt-0.5" />
      ) : doneAt ? (
        <CheckCircle2 className="h-5 w-5 text-zinc-700 mt-0.5" />
      ) : (
        <Loader2 className="h-5 w-5 animate-spin text-zinc-700 mt-0.5" />
      )}
      <div className="text-sm text-zinc-800">
        {error ? (
          <div>失敗しました: {error}</div>
        ) : doneAt ? (
          <div>バージョン v{doneAt.versionNumber} を生成しました。</div>
        ) : (
          <>
            <div className="font-medium">台本を生成中…（Gemini 3.1 Pro, HIGH thinking）</div>
            {lastStep && <div className="text-xs text-zinc-500">step: {lastStep.name} ({lastStep.status})</div>}
            {lastChunk && <div className="text-xs text-zinc-500">streamed {lastChunk.chars.toLocaleString()} 文字</div>}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/screenplay/GenerationProgress.tsx
git commit -m "feat(screenplays): progress component with NDJSON + status fallback"
```

---

## Task 13: Version timeline + viewer + feedback form

**Files:**
- Create: `components/screenplay/VersionTimeline.tsx`
- Create: `components/screenplay/ScreenplayViewer.tsx`
- Create: `components/screenplay/FeedbackForm.tsx`

- [ ] **Step 1: VersionTimeline**

```tsx
// components/screenplay/VersionTimeline.tsx
"use client";
import { Check, FileText } from "lucide-react";
import type { ScreenplayVersionRow } from "@/lib/screenplay/types";

interface Props {
  versions: Pick<ScreenplayVersionRow, "id" | "version_number" | "feedback" | "created_at">[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function VersionTimeline({ versions, selectedId, onSelect }: Props) {
  return (
    <ol className="space-y-2">
      {versions.map((v) => {
        const active = v.id === selectedId;
        return (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => onSelect(v.id)}
              className={`w-full text-left rounded border px-3 py-2 flex gap-3 items-start ${active ? "border-zinc-900 bg-zinc-900 text-zinc-50" : "border-zinc-200 bg-white hover:border-zinc-400"}`}
            >
              <div className="mt-0.5">
                {active ? <Check className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold">v{v.version_number}</div>
                <div className={`text-xs truncate ${active ? "text-zinc-300" : "text-zinc-500"}`}>
                  {v.feedback ? `「${v.feedback}」` : "初回生成"}
                </div>
                <div className={`text-[10px] ${active ? "text-zinc-400" : "text-zinc-400"}`}>
                  {new Date(v.created_at).toLocaleString("ja-JP")}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 2: ScreenplayViewer**

```tsx
// components/screenplay/ScreenplayViewer.tsx
"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface Props {
  markdown: string;
  title: string;
}

export function ScreenplayViewer({ markdown, title }: Props) {
  const [copied, setCopied] = useState(false);

  function downloadMd() {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyMd() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div>
      <div className="flex items-center justify-end gap-2 mb-3 text-sm">
        <button type="button" onClick={copyMd} className="px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50">
          {copied ? "コピー済み" : "Markdown コピー"}
        </button>
        <button type="button" onClick={downloadMd} className="px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50 inline-flex items-center gap-1">
          <Download className="h-3.5 w-3.5" /> .md ダウンロード
        </button>
      </div>
      <ScreenplayMarkdown markdown={markdown} />
    </div>
  );
}
```

- [ ] **Step 3: FeedbackForm**

```tsx
// components/screenplay/FeedbackForm.tsx
"use client";
import { useState } from "react";
import { Send } from "lucide-react";

interface Props {
  screenplayId: string;
  baseVersionId: string;
  disabled?: boolean;
  onStart: (runId: string) => void;
}

const SUGGESTIONS = [
  "実演デモを最後の方に移動してください。",
  "価格発表をもっと劇的に。値段を見せる前に値引きの理由を一段重ねてください。",
  "お客様の声を3人に増やして、年代と職業を変えてください。",
];

export function FeedbackForm({ screenplayId, baseVersionId, disabled, onStart }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const feedback = text.trim();
    if (!feedback) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/screenplays/${screenplayId}/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback, baseVersionId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "refine failed");
      onStart(j.runId as string);
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-zinc-200 bg-white p-4">
      <label className="text-sm font-bold block mb-2">フィードバックを入力して改稿</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        disabled={disabled || busy}
        placeholder="例: 実演デモを最後に入れてください。お客様の声を3人に増やして、それぞれの職業を変えてください。"
        className="w-full border border-zinc-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-900"
      />
      <div className="flex flex-wrap gap-2 mt-2">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => setText((t) => (t ? t + "\n" : "") + s)} className="text-xs px-2 py-1 border border-zinc-200 rounded hover:bg-zinc-50">
            {s}
          </button>
        ))}
      </div>
      {err && <div className="text-xs text-zinc-700 mt-2">{err}</div>}
      <div className="flex justify-end mt-3">
        <button
          type="button"
          onClick={submit}
          disabled={disabled || busy || !text.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 text-zinc-50 rounded text-sm disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          {busy ? "送信中…" : "この内容で改稿する"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add components/screenplay/VersionTimeline.tsx components/screenplay/ScreenplayViewer.tsx components/screenplay/FeedbackForm.tsx
git commit -m "feat(screenplays): version timeline + viewer + feedback form"
```

---

## Task 14: List + create UI pages

**Files:**
- Create: `app/[locale]/screenplays/page.tsx`
- Create: `app/[locale]/screenplays/new/page.tsx`
- Create: `components/screenplay/ScreenplayList.tsx`
- Create: `components/screenplay/ScreenplayCreateForm.tsx`

- [ ] **Step 1: ScreenplayList**

```tsx
// components/screenplay/ScreenplayList.tsx
"use client";
import Link from "next/link";

interface Row {
  id: string;
  title: string;
  status: "pending" | "generating" | "ready" | "failed";
  updated_at: string;
}

const STATUS_LABEL: Record<Row["status"], string> = {
  pending: "待機",
  generating: "生成中",
  ready: "完成",
  failed: "失敗",
};

export function ScreenplayList({ rows, locale }: { rows: Row[]; locale: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">まだ台本はありません。「新規作成」から始めてください。</p>;
  }
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {rows.map((r) => (
        <li key={r.id}>
          <Link
            href={`/${locale}/screenplays/${r.id}`}
            className="block rounded border border-zinc-200 bg-white p-4 hover:border-zinc-900"
          >
            <div className="text-sm font-bold truncate">{r.title}</div>
            <div className="text-xs text-zinc-500 mt-1">
              {STATUS_LABEL[r.status]} ・ {new Date(r.updated_at).toLocaleString("ja-JP")}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: list page (Server Component)**

```tsx
// app/[locale]/screenplays/page.tsx
import Link from "next/link";
import { Plus } from "lucide-react";
import { ScreenplayList } from "@/components/screenplay/ScreenplayList";

export const dynamic = "force-dynamic";

async function fetchList() {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const res = await fetch(`${base}/api/screenplays`, { cache: "no-store" });
  if (!res.ok) return [];
  const j = await res.json() as { screenplays: { id: string; title: string; status: "pending"|"generating"|"ready"|"failed"; updated_at: string }[] };
  return j.screenplays;
}

export default async function ScreenplaysPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const rows = await fetchList();
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black">テレビショッピング 台本</h1>
          <p className="text-sm text-zinc-500 mt-1">商品ごとに、生放送さながらの台本を生成・改稿できます。</p>
        </div>
        <Link href={`/${locale}/screenplays/new`} className="inline-flex items-center gap-2 bg-zinc-900 text-zinc-50 px-4 py-2 rounded text-sm">
          <Plus className="h-4 w-4" /> 新規作成
        </Link>
      </header>
      <ScreenplayList rows={rows} locale={locale} />
    </main>
  );
}
```

- [ ] **Step 3: create form**

```tsx
// components/screenplay/ScreenplayCreateForm.tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Sparkles } from "lucide-react";

export function ScreenplayCreateForm({ locale }: { locale: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [list, setList] = useState("");
  const [sale, setSale] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = {
        productBrief: {
          name: name.trim(),
          category: category.trim() || undefined,
          description: description.trim(),
          price: {
            listJpy: list ? Number(list) : undefined,
            saleJpy: sale ? Number(sale) : undefined,
          },
        },
      };
      const res = await fetch(`/api/screenplays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "create failed");
      router.push(`/${locale}/screenplays/${j.id}?run=${j.runId}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 max-w-2xl">
      <div>
        <label className="text-sm font-bold block mb-1">商品名 *</label>
        <input value={name} onChange={(e)=>setName(e.target.value)} required className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" />
      </div>
      <div>
        <label className="text-sm font-bold block mb-1">カテゴリ</label>
        <input value={category} onChange={(e)=>setCategory(e.target.value)} className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" placeholder="例: ヘルスケア・日用品" />
      </div>
      <div>
        <label className="text-sm font-bold block mb-1">特徴・スペック *</label>
        <textarea value={description} onChange={(e)=>setDescription(e.target.value)} required rows={10} className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" placeholder="商品の特徴、対象ユーザー、素材、技術的なポイントなど自由に貼り付けてください。" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-bold block mb-1">メーカー直販価格 (¥)</label>
          <input type="number" value={list} onChange={(e)=>setList(e.target.value)} className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-sm font-bold block mb-1">本日特別価格 (¥)</label>
          <input type="number" value={sale} onChange={(e)=>setSale(e.target.value)} className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" />
        </div>
      </div>
      {err && <div className="text-xs text-zinc-700">{err}</div>}
      <div className="flex justify-end">
        <button disabled={busy || !name.trim() || !description.trim()} className="inline-flex items-center gap-2 bg-zinc-900 text-zinc-50 px-4 py-2 rounded text-sm disabled:opacity-50">
          <Sparkles className="h-4 w-4" /> {busy ? "送信中…" : "台本を生成する"}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: new page**

```tsx
// app/[locale]/screenplays/new/page.tsx
import { ScreenplayCreateForm } from "@/components/screenplay/ScreenplayCreateForm";

export default async function NewScreenplayPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-black mb-2">新しい台本</h1>
      <p className="text-sm text-zinc-500 mb-6">商品情報を入力してください。生成完了まで2〜5分かかります。</p>
      <ScreenplayCreateForm locale={locale} />
    </main>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add app/[locale]/screenplays/page.tsx app/[locale]/screenplays/new/page.tsx components/screenplay/ScreenplayList.tsx components/screenplay/ScreenplayCreateForm.tsx
git commit -m "feat(screenplays): list + new pages"
```

---

## Task 15: Detail page (the iteration UI)

**Files:**
- Create: `app/[locale]/screenplays/[id]/page.tsx`
- Create: `components/screenplay/ScreenplayWorkspace.tsx`

- [ ] **Step 1: ScreenplayWorkspace (client orchestrator)**

```tsx
// components/screenplay/ScreenplayWorkspace.tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GenerationProgress } from "./GenerationProgress";
import { VersionTimeline } from "./VersionTimeline";
import { ScreenplayViewer } from "./ScreenplayViewer";
import { FeedbackForm } from "./FeedbackForm";
import type { ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";

interface Props {
  initialScreenplay: ScreenplayRow;
  initialVersions: ScreenplayVersionRow[];
}

export function ScreenplayWorkspace({ initialScreenplay, initialVersions }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const [versions, setVersions] = useState(initialVersions);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialScreenplay.current_version_id ?? initialVersions[initialVersions.length - 1]?.id ?? null,
  );
  const [runId, setRunId] = useState<string | null>(search.get("run"));

  useEffect(() => {
    if (!runId) return;
    // GenerationProgress's onComplete will refresh.
  }, [runId]);

  async function refreshList(newSelectedId?: string) {
    const res = await fetch(`/api/screenplays/${initialScreenplay.id}`, { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json() as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
    setVersions(j.versions);
    setSelectedId(newSelectedId ?? j.screenplay.current_version_id ?? j.versions[j.versions.length - 1]?.id ?? null);
  }

  function handleComplete(versionId: string) {
    setRunId(null);
    void refreshList(versionId);
    // clear ?run= from URL
    const params = new URLSearchParams(search);
    params.delete("run");
    router.replace(`?${params.toString()}`);
  }

  function handleRefineStart(newRunId: string) {
    setRunId(newRunId);
  }

  const selected = versions.find((v) => v.id === selectedId);
  const isGenerating = !!runId;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr_320px] gap-6">
      <aside className="lg:sticky lg:top-6 self-start">
        <h2 className="text-sm font-bold mb-3">改稿履歴</h2>
        <VersionTimeline
          versions={versions.map((v) => ({ id: v.id, version_number: v.version_number, feedback: v.feedback, created_at: v.created_at }))}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </aside>

      <section className="min-w-0">
        {isGenerating && runId && (
          <div className="mb-4">
            <GenerationProgress
              runId={runId}
              onComplete={(versionId) => handleComplete(versionId)}
            />
          </div>
        )}
        {selected ? (
          <ScreenplayViewer markdown={selected.markdown} title={initialScreenplay.title} />
        ) : (
          <p className="text-sm text-zinc-500">まだバージョンがありません。</p>
        )}
      </section>

      <aside className="lg:sticky lg:top-6 self-start">
        {selected ? (
          <FeedbackForm
            screenplayId={initialScreenplay.id}
            baseVersionId={selected.id}
            disabled={isGenerating}
            onStart={handleRefineStart}
          />
        ) : null}
      </aside>
    </div>
  );
}
```

- [ ] **Step 2: detail page (Server Component)**

```tsx
// app/[locale]/screenplays/[id]/page.tsx
import { notFound } from "next/navigation";
import { ScreenplayWorkspace } from "@/components/screenplay/ScreenplayWorkspace";
import type { ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";

export const dynamic = "force-dynamic";

async function fetchDetail(id: string) {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const res = await fetch(`${base}/api/screenplays/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  return await res.json() as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
}

export default async function ScreenplayDetailPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id } = await params;
  const data = await fetchDetail(id);
  if (!data) notFound();
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-6">
        <div className="text-xs text-zinc-500 mb-1">テレビショッピング台本</div>
        <h1 className="text-2xl font-black">{data.screenplay.title}</h1>
      </header>
      <ScreenplayWorkspace initialScreenplay={data.screenplay} initialVersions={data.versions} />
    </main>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/[locale]/screenplays/[id]/page.tsx components/screenplay/ScreenplayWorkspace.tsx
git commit -m "feat(screenplays): detail page with iteration workspace"
```

---

## Task 16: Navbar entry + i18n strings

**Files:**
- Modify: `components/Navbar.tsx`
- Modify: `messages/ja.json`
- Modify: `messages/en.json`
- Create: `messages/ko.json`
- Possibly modify: `i18n.ts` (register `ko`)

- [ ] **Step 1: Add nav link**

Open `components/Navbar.tsx` and add a `<Link>` to `/${locale}/screenplays` between existing nav items, using the same component style as the other links. Use a `lucide-react` icon (e.g. `<Clapperboard />`).

- [ ] **Step 2: Add Japanese strings**

In `messages/ja.json`, add under the root:

```json
"screenplay": {
  "navLabel": "台本ジェネレーター",
  "title": "テレビショッピング 台本",
  "subtitle": "商品ごとに、生放送さながらの台本を生成・改稿できます。",
  "new": "新規作成",
  "noneYet": "まだ台本はありません。「新規作成」から始めてください。",
  "status": { "pending": "待機", "generating": "生成中", "ready": "完成", "failed": "失敗" },
  "form": {
    "productName": "商品名",
    "category": "カテゴリ",
    "description": "特徴・スペック",
    "listPrice": "メーカー直販価格 (¥)",
    "salePrice": "本日特別価格 (¥)",
    "submit": "台本を生成する"
  },
  "workspace": {
    "history": "改稿履歴",
    "v1": "初回生成",
    "downloadMd": ".md ダウンロード",
    "copyMd": "Markdown コピー",
    "copied": "コピー済み"
  },
  "feedback": {
    "label": "フィードバックを入力して改稿",
    "placeholder": "例: 実演デモを最後に入れてください。お客様の声を3人に増やして、それぞれの職業を変えてください。",
    "submit": "この内容で改稿する",
    "sending": "送信中…"
  }
}
```

- [ ] **Step 3: Add English strings**

Mirror the JSON above in `messages/en.json` with English equivalents (e.g. `"navLabel": "Screenplay Generator"`, etc.).

- [ ] **Step 4: Add Korean strings**

Create `messages/ko.json` with the same shape and Korean values:

```json
{
  "screenplay": {
    "navLabel": "스크립트 생성기",
    "title": "TV 홈쇼핑 스크립트",
    "subtitle": "상품마다 생방송과 똑같은 스크립트를 생성하고 피드백으로 다듬을 수 있습니다.",
    "new": "새로 만들기",
    "noneYet": "아직 스크립트가 없습니다. '새로 만들기'에서 시작하세요.",
    "status": { "pending": "대기", "generating": "생성 중", "ready": "완료", "failed": "실패" },
    "form": {
      "productName": "상품명",
      "category": "카테고리",
      "description": "특징·스펙",
      "listPrice": "정가 (¥)",
      "salePrice": "특가 (¥)",
      "submit": "스크립트 생성하기"
    },
    "workspace": {
      "history": "버전 기록",
      "v1": "최초 생성",
      "downloadMd": ".md 다운로드",
      "copyMd": "Markdown 복사",
      "copied": "복사 완료"
    },
    "feedback": {
      "label": "피드백을 입력해 다시 다듬기",
      "placeholder": "예: 실연 데모를 마지막에 배치해주세요. 고객 후기를 3명으로 늘리고 각자의 직업을 다르게 해주세요.",
      "submit": "이 내용으로 다시 생성",
      "sending": "전송 중…"
    }
  }
}
```

Other top-level keys: copy from `ja.json` then translate the values used by existing pages so navigation doesn't break for Korean visitors. (Skip if the team accepts ja-only outside this feature — confirm before doing it.)

- [ ] **Step 5: Register `ko` in `i18n.ts`**

Open `i18n.ts` — if there is a list like `const locales = ["ja", "en"]`, change to `["ja", "en", "ko"]`. Same for any `defaultLocale` or routing config.

- [ ] **Step 6: Replace hard-coded Japanese in components with `useTranslations`**

In each new component that contains hard-coded Japanese strings (`ScreenplayList`, `ScreenplayCreateForm`, `FeedbackForm`, `ScreenplayWorkspace`, `VersionTimeline`, `GenerationProgress`), import `import { useTranslations } from "next-intl"` and replace each hard-coded string with `t("screenplay....")`. For server pages, use `getTranslations` from `next-intl/server`.

- [ ] **Step 7: Commit**

```bash
git add components/Navbar.tsx messages/ja.json messages/en.json messages/ko.json i18n.ts components/screenplay/
git commit -m "feat(screenplays): nav entry + i18n (ja/en/ko)"
```

---

## Task 17: Smoke test script

**Files:**
- Create: `scripts/test-screenplay-generator.ts`
- Modify: `package.json` (add `test:screenplay` script)

- [ ] **Step 1: Write the smoke test**

```ts
// scripts/test-screenplay-generator.ts
// Hits the generator end-to-end with a fake product brief and writes the markdown
// to /tmp/screenplay-test.md for visual inspection. Does NOT touch the DB.
import { generateScreenplay } from "@/lib/screenplay/generator";
import { writeFile } from "node:fs/promises";

async function main() {
  const initial = await generateScreenplay({
    mode: "initial",
    productBrief: {
      name: "テスト商品X",
      category: "ヘルスケア",
      description: "1枚のレンズで手元から少し先まで見える老眼鏡。+1.0〜+2.5度数対応。重さ約20g、βチタンテンプル。",
      price: { listJpy: 14800, saleJpy: 9800, shippingJpy: 950 },
      guarantee: "1年保証",
    },
  });
  console.log(`initial: ${initial.markdown.length} chars`);
  await writeFile("/tmp/screenplay-test-v1.md", initial.markdown, "utf-8");

  const refined = await generateScreenplay({
    mode: "refine",
    productBrief: {
      name: "テスト商品X",
      category: "ヘルスケア",
      description: "1枚のレンズで手元から少し先まで見える老眼鏡。+1.0〜+2.5度数対応。重さ約20g、βチタンテンプル。",
      price: { listJpy: 14800, saleJpy: 9800, shippingJpy: 950 },
      guarantee: "1年保証",
    },
    feedback: "実演デモを最後の方に移動してください。お客様の声を3人に増やしてください。",
    previousMarkdown: initial.markdown,
  });
  console.log(`refined: ${refined.markdown.length} chars`);
  await writeFile("/tmp/screenplay-test-v2.md", refined.markdown, "utf-8");
  console.log("Saved /tmp/screenplay-test-v1.md and v2.md");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add npm script**

In `package.json`, under `"scripts"`, add:

```json
"test:screenplay": "tsx --env-file=.env.local scripts/test-screenplay-generator.ts"
```

- [ ] **Step 3: Run it**

Run: `npm run test:screenplay`
Expected: two markdown files written; v1 ~30-60K chars, v2 ~30-60K chars and visibly reflects the feedback (demo near the end, three customers).

- [ ] **Step 4: Commit**

```bash
git add scripts/test-screenplay-generator.ts package.json
git commit -m "test(screenplays): end-to-end generator smoke test"
```

---

## Task 18: Manual UI verification

This is a verification gate — no code changes. Confirm everything works as a user would experience it.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Open: `http://localhost:3000/ja/screenplays`
Expected: empty state, "新規作成" button visible, nav shows the new "台本ジェネレーター" link.

- [ ] **Step 2: Create a screenplay**

Click "新規作成". Paste the `アイアジャストグラス` text from `/Users/kjyoo/jp-script/product information.` into the description field (skip the JANコード and 梱包 sections). Set sale price ¥9,800. Submit.
Expected: redirect to `/ja/screenplays/{id}?run={runId}`. Progress component shows step + streamed char count. Within ~2-5 min, status becomes ready and v1 markdown renders.

- [ ] **Step 3: Verify rendered structure**

Scroll through the rendered screenplay. Confirm:
- All 8 sections present (アバン, スタジオ①〜④, CTA1, VTR, CTA2)
- `[テロップ]`, `[カメラ]`, `[BGM]`, `[SE]` cues render as bordered cards
- Speaker lines render in two columns (role | dialogue+delivery+EN)
- A Markdown table appears for the offer sheet
- No SVG, no images

- [ ] **Step 4: Refine with Korean feedback**

In the feedback box, paste: `이 특징 설명은 마지막에 넣어 주세요. 실 끼우기 시연을 넣어 주세요.`
Click "この内容で改稿する".
Expected: progress component reappears. After completion v2 appears in the timeline and is auto-selected. The new version should show a thread-threading (실 끼우기) demo and move the named feature explanation later in the script.

- [ ] **Step 5: Verify version selection**

Click v1 in the left timeline. Viewer switches back to v1. Click v2. Viewer switches back. Both versions persist.

- [ ] **Step 6: Verify download / copy**

Click "Markdown コピー". Paste into a scratch file — confirm it's the rendered screenplay's source. Click ".md ダウンロード" — confirm file downloads.

- [ ] **Step 7: Test failure path**

Temporarily set `GEMINI_API_KEY` to an invalid value in `.env.local`. Restart dev server. Try generating a new screenplay.
Expected: progress component shows error, screenplay row in DB has `status = 'failed'`, list page shows "失敗".
Restore the key after testing.

- [ ] **Step 8: Commit verification notes**

Take screenshots of the three states (initial generation, v2 after refine, version timeline). Save to `docs/superpowers/plans/2026-05-13-screenplay-generator.assets/`. Commit:

```bash
git add docs/superpowers/plans/2026-05-13-screenplay-generator.assets/
git commit -m "docs(screenplays): manual verification screenshots"
```

---

## Self-Review Checklist

- ✅ All 18 tasks have explicit file paths, complete code, and commit steps.
- ✅ Task 1 (schema) covers all data needed by Tasks 7-10 (status, current_version_id, last_run_id, base_version_id, feedback, model, thinking_level, token_usage).
- ✅ The `ProgressEvent` type defined in Task 3 is used identically in Tasks 6, 10, 12.
- ✅ The `screenplayWorkflow` signature in Task 6 matches the `start(screenplayWorkflow, [{...}])` calls in Tasks 7 and 9.
- ✅ The route `/api/screenplays/run/[runId]/stream` mirrors `md-strategy/run/[runId]/stream` byte-for-byte in shape.
- ✅ No SVG, no figures — Task 4's prompt explicitly forbids them; Task 11's renderer doesn't recognize image tags.
- ✅ The iterative-feedback flow works: Task 9 reads `current_version_id` as default base, Task 13's `FeedbackForm` passes `baseVersionId`, Task 4's `buildPrompt` injects `previousMarkdown` + `feedback`.
- ✅ Output length target (30-60K chars) matches Task 5's `< 1000` rejection and Task 17's smoke-test expectation.
- ✅ Worktree-safe: every task changes only its declared files; no cross-task overlap besides the i18n + Navbar modifications in Task 16.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-screenplay-generator.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best when you want oversight at each natural checkpoint (DB → lib → API → UI).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster end-to-end if you trust the plan.

Which approach?
