# Screenplay Version Diff (変更点レビュー) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator see, for any refined screenplay version, an exact diff against the version it was refined from (its `base_version_id` parent) with a one-line AI reason per changed region.

**Architecture:** A shared pure `diff.ts` computes line-level hunks (client renders them; server uses the same module to index an AI rationale call). A lazy endpoint returns per-hunk reasons, cached success-only + key-validated in `screenplay_versions.change_notes jsonb`. The viewer gains a 「変更点」 toggle. Diff = ground truth; AI only explains.

**Tech Stack:** Next.js 16 App Router, Supabase, `@google/generative-ai` (Gemini 3.5 Flash), `diff` (jsdiff, new), Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-06-16-screenplay-version-diff-design.md`

---

## File Structure

New:
- `lib/screenplay/diff.ts` — `computeLineDiff(base, next): DiffHunk[]` + `DIFF_VERSION`. Pure, shared client+server.
- `lib/screenplay/change-rationale.ts` — `explainChanges(...)` (Gemini) + `parseHunkReasons(...)` + `PROMPT_VERSION`.
- `app/api/screenplays/[id]/versions/[versionId]/changes/route.ts` — lazy rationale endpoint (cache).
- `components/screenplay/ChangeDiffView.tsx` — client diff renderer + rationale fetch.
- `supabase/migrations/2026-06-16_screenplay_version_change_notes.sql` — `change_notes jsonb` column.
- `scripts/test-screenplay-diff.ts` — diff units + parse units + live smoke.

Modified:
- `lib/screenplay/types.ts` — add `DiffLine` / `DiffHunk` / `HunkReason` / `ChangeNotesKey` / `ChangeNotes`; add `change_notes` to `ScreenplayVersionRow`.
- `components/screenplay/ScreenplayViewer.tsx` — `baseMarkdown`/`screenplayId`/`versionId` props + 「変更点」 toggle.
- `components/screenplay/ScreenplayWorkspace.tsx` — pass parent markdown + ids to the viewer.
- `app/api/screenplays/[id]/refine/route.ts` — guard `baseVersionId` belongs to the screenplay.
- `package.json` — add `diff` + `@types/diff`, add `test:screenplay-diff` script.

---

## Task 1: Add the `diff` (jsdiff) dependency

**Files:** Modify `package.json` (+ lockfile)

- [ ] **Step 1: Install**

Run:
```bash
npm install diff@^7.0.0 && npm install -D @types/diff@^7.0.0
```
Expected: `diff` in `dependencies`, `@types/diff` in `devDependencies`, lockfile updated.

- [ ] **Step 2: Verify it imports under tsx**

Run:
```bash
npx tsx -e "import { diffLines } from 'diff'; console.log(typeof diffLines)"
```
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(screenplay): add diff (jsdiff) for version-diff review"
```

---

## Task 2: Shared types in `types.ts`

**Files:** Modify `lib/screenplay/types.ts`

- [ ] **Step 1: Append the diff/rationale types**

Add to the end of `lib/screenplay/types.ts`:
```ts
// ── Version diff (変更点レビュー) ───────────────────────────────────────────
export interface DiffLine {
  type: "context" | "added" | "removed";
  text: string;
}
export interface DiffHunk {
  index: number;       // stable ordinal; aligns client render ↔ server rationale
  lines: DiffLine[];
}
export interface HunkReason {
  index: number;       // matches DiffHunk.index
  reason: string;
}
/** Cache invalidation key for change_notes — any field change forces recompute. */
export interface ChangeNotesKey {
  diffVersion: number;
  promptVersion: number;
  model: string;
  baseVersionId: string;
  baseCheckId: string | null;
  hunkCount: number;
}
/** Persisted in screenplay_versions.change_notes — written only on success. */
export interface ChangeNotes {
  ok: true;
  key: ChangeNotesKey;
  rationale: HunkReason[];
  computedAt: string;
}
```

- [ ] **Step 2: Add `change_notes` to `ScreenplayVersionRow`**

In `lib/screenplay/types.ts`, in the `ScreenplayVersionRow` interface, add after the `token_usage` line:
```ts
	change_notes: ChangeNotes | null;
```

- [ ] **Step 3: tsc check**

Run: `npx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 4: Commit**

```bash
git add lib/screenplay/types.ts
git commit -m "feat(screenplay): shared diff/rationale types + change_notes"
```

---

## Task 3: `diff.ts` — line diff into hunks (TDD)

**Files:** Create `lib/screenplay/diff.ts`, Create `scripts/test-screenplay-diff.ts`, Modify `package.json`

- [ ] **Step 1: Create the test scaffold with diff units (failing)**

Create `scripts/test-screenplay-diff.ts`:
```ts
// scripts/test-screenplay-diff.ts
//   - npx tsx scripts/test-screenplay-diff.ts        # units (offline)
//   - npm run test:screenplay-diff                   # + live Gemini rationale
import { computeLineDiff } from "../lib/screenplay/diff";

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail?: string }[] = [];
function pass(n: string, d = "") { results.push({ name: n, status: "PASS", detail: d }); console.log(`  ✅ ${n}${d ? " — " + d : ""}`); }
function fail(n: string, d = "") { results.push({ name: n, status: "FAIL", detail: d }); console.log(`  ❌ ${n} — ${d}`); }
function skip(n: string, d = "") { results.push({ name: n, status: "SKIP", detail: d }); console.log(`  ⏭️  ${n} — ${d}`); }

function testComputeLineDiff() {
  console.log("\n[computeLineDiff] unit");
  try {
    if (computeLineDiff("a\nb\nc", "a\nb\nc").length !== 0) throw new Error("no-change should be []");
    pass("no change → no hunks");
  } catch (e) { fail("no change → no hunks", (e as Error).message); }

  try {
    const h = computeLineDiff("a\nb", "a\nX\nb");
    if (h.length !== 1) throw new Error(`expected 1 hunk, got ${h.length}`);
    if (!h[0].lines.some((l) => l.type === "added" && l.text === "X")) throw new Error("missing added line X");
    pass("pure addition");
  } catch (e) { fail("pure addition", (e as Error).message); }

  try {
    const h = computeLineDiff("a\nX\nb", "a\nb");
    if (h.length !== 1 || !h[0].lines.some((l) => l.type === "removed" && l.text === "X")) throw new Error("missing removed line X");
    pass("pure removal");
  } catch (e) { fail("pure removal", (e as Error).message); }

  try {
    const h = computeLineDiff("a\nold\nb", "a\nnew\nb");
    const hasRem = h[0].lines.some((l) => l.type === "removed" && l.text === "old");
    const hasAdd = h[0].lines.some((l) => l.type === "added" && l.text === "new");
    if (!hasRem || !hasAdd) throw new Error("modification should show both removed+added");
    pass("modification = removed + added");
  } catch (e) { fail("modification = removed + added", (e as Error).message); }

  try {
    const base = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const next = base.replace("line2", "line2X").replace("line25", "line25X");
    const h = computeLineDiff(base, next);
    if (h.length !== 2) throw new Error(`expected 2 far-apart hunks, got ${h.length}`);
    if (h[0].index !== 0 || h[1].index !== 1) throw new Error("hunk indices must be 0,1");
    pass("two far-apart changes → 2 hunks, indices 0,1");
  } catch (e) { fail("two far-apart changes", (e as Error).message); }
}

async function main() {
  console.log("=== screenplay/diff test ===");
  testComputeLineDiff();
  const f = results.filter((r) => r.status === "FAIL").length;
  const p = results.filter((r) => r.status === "PASS").length;
  const s = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n=== ${p} pass, ${f} fail, ${s} skip ===`);
  process.exit(f > 0 ? 1 : 0);
}
main().catch((e) => { console.error("Unhandled:", e); process.exit(1); });
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx tsx scripts/test-screenplay-diff.ts`
Expected: import/run error — `lib/screenplay/diff` does not exist.

- [ ] **Step 3: Create `lib/screenplay/diff.ts`**

```ts
// lib/screenplay/diff.ts
// Pure line-level diff → hunks. Shared by the client renderer (ChangeDiffView)
// and the server rationale endpoint, so hunk ordinals align on both sides.
// No "server-only" — importable from the browser and tsx smoke scripts.
import { diffLines } from "diff";
import type { DiffLine, DiffHunk } from "./types";

// Bump when the hunking algorithm changes (part of the change_notes cache key).
export const DIFF_VERSION = 1;

const CONTEXT = 3;

export function computeLineDiff(base: string, next: string): DiffHunk[] {
  const parts = diffLines(base ?? "", next ?? "");
  const flat: DiffLine[] = [];
  for (const p of parts) {
    const type: DiffLine["type"] = p.added ? "added" : p.removed ? "removed" : "context";
    const lines = p.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // drop trailing newline artifact
    for (const text of lines) flat.push({ type, text });
  }

  const changed: number[] = [];
  for (let i = 0; i < flat.length; i++) if (flat[i].type !== "context") changed.push(i);
  if (changed.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < changed.length) {
    const start = changed[i];
    let j = i;
    let end = start;
    // merge changes separated by <= 2*CONTEXT context lines into one hunk
    while (j + 1 < changed.length && changed[j + 1] - changed[j] <= 2 * CONTEXT) {
      j++;
      end = changed[j];
    }
    const from = Math.max(0, start - CONTEXT);
    const to = Math.min(flat.length - 1, end + CONTEXT);
    hunks.push({ index: hunks.length, lines: flat.slice(from, to + 1) });
    i = j + 1;
  }
  return hunks;
}
```

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, after `"test:screenplay-import"`, add:
```json
    "test:screenplay-diff": "tsx --env-file=.env.local scripts/test-screenplay-diff.ts",
```

- [ ] **Step 5: Run — verify it passes**

Run: `npx tsx scripts/test-screenplay-diff.ts`
Expected: `5 pass, 0 fail, 0 skip`.

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/diff.ts scripts/test-screenplay-diff.ts package.json
git commit -m "feat(screenplay): computeLineDiff (shared line diff → hunks)"
```

---

## Task 4: `change-rationale.ts` — AI per-hunk reasons (TDD)

**Files:** Create `lib/screenplay/change-rationale.ts`, Modify `scripts/test-screenplay-diff.ts`

- [ ] **Step 1: Add parse + live-smoke tests (failing)**

In `scripts/test-screenplay-diff.ts`, add imports at top:
```ts
import { parseHunkReasons, explainChanges, PROMPT_VERSION } from "../lib/screenplay/change-rationale";
import { computeLineDiff as _cld } from "../lib/screenplay/diff";
```
Add these functions before `main()`:
```ts
function testParseHunkReasons() {
  console.log("\n[parseHunkReasons] unit");
  try {
    const r = parseHunkReasons('[{"index":0,"reason":"値段表現を修正"},{"index":1,"reason":"文体調整"}]', 2);
    if (r.length !== 2 || r[0].reason !== "値段表現を修正") throw new Error("happy path mismatch");
    pass("parses valid reasons");
  } catch (e) { fail("parses valid reasons", (e as Error).message); }

  try {
    const r = parseHunkReasons('prefix [{"index":0,"reason":"ok"},{"index":9,"reason":"out of range"}] suffix', 2);
    if (r.length !== 1 || r[0].index !== 0) throw new Error("should drop out-of-range index + strip prose");
    pass("drops out-of-range index, strips prose");
  } catch (e) { fail("drops out-of-range index, strips prose", (e as Error).message); }

  try {
    const r = parseHunkReasons('[{"index":0,"reason":""},{"index":1,"reason":"  "}]', 2);
    if (r.length !== 0) throw new Error("empty reasons should be dropped");
    pass("drops empty reasons");
  } catch (e) { fail("drops empty reasons", (e as Error).message); }

  try {
    parseHunkReasons("not json at all", 2);
    fail("throws on non-JSON", "did not throw");
  } catch (e) { pass("throws on non-JSON", (e as Error).message); }

  if (PROMPT_VERSION >= 1) pass("PROMPT_VERSION exported"); else fail("PROMPT_VERSION exported", `got ${PROMPT_VERSION}`);
}

async function testExplainChangesLive() {
  console.log("\n[explainChanges] live Gemini smoke");
  if (!process.env.GEMINI_API_KEY) { skip("explainChanges", "GEMINI_API_KEY not set"); return; }
  try {
    const hunks = _cld("税込15,800円です。", "単品合計より2,160円お得な税込13,800円です。");
    const r = await explainChanges(hunks, "値段表現を景表法に合わせて修正", []);
    if (!Array.isArray(r)) throw new Error("not an array");
    pass("explainChanges returns reasons", `${r.length} reason(s)`);
  } catch (e) { fail("explainChanges returns reasons", (e as Error).message); }
}
```
Register inside `main()` after `testComputeLineDiff();`:
```ts
  testParseHunkReasons();
  await testExplainChangesLive();
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx tsx scripts/test-screenplay-diff.ts`
Expected: import/run error — `change-rationale` module does not exist.

- [ ] **Step 3: Create `lib/screenplay/change-rationale.ts`**

```ts
// lib/screenplay/change-rationale.ts
// Gemini: explain WHY each computed diff hunk changed (it does not re-derive the
// changes — it annotates the hunks it is given). No "server-only" — matches the
// repo convention for Gemini modules with a tsx smoke (extract/from-pdf.ts,
// import/normalize.ts). Imported ONLY by the changes route; the client never
// imports it (it uses the endpoint + shared types in types.ts).
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import type { DiffHunk, HunkReason } from "./types";
import type { Finding } from "./compliance/types";

// Bump when the prompt below changes (part of the change_notes cache key).
export const PROMPT_VERSION = 1;

const SYSTEM_INSTRUCTION = `あなたはテレビショッピング台本の改稿レビュー補助です。
すでに計算済みの「変更箇所(hunk)」が与えられます。各 hunk について、なぜそう変更されたのかを日本語で一行で説明してください。

ルール:
- 出力は厳密な JSON 配列のみ。前置き・コードフェンス禁止。形式: [{"index": number, "reason": string}]
- 理由は「改稿の指示」と「直前バージョンの試験指摘」に基づいて述べる。
- 指示にも指摘にも結びつかない変更は "文体・表現の調整" とする。コンプライアンス上の理由を捏造しない。
- 与えられた hunk の index 以外は出力しない。各 reason は60文字以内。`;

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

export function parseHunkReasons(text: string, hunkCount: number): HunkReason[] {
  const match = text.trim().match(/\[[\s\S]*\]/);
  if (!match) throw new Error("rationale response had no JSON array");
  const arr = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(arr)) throw new Error("rationale response was not an array");
  const out: HunkReason[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const index = typeof o.index === "number" ? o.index : Number(o.index);
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    if (Number.isInteger(index) && index >= 0 && index < hunkCount && reason) {
      out.push({ index, reason: reason.slice(0, 300) });
    }
  }
  return out;
}

export async function explainChanges(
  hunks: DiffHunk[],
  feedback: string | null,
  findings: Finding[],
): Promise<HunkReason[]> {
  if (hunks.length === 0) return [];
  const model = getGenAI().getGenerativeModel({
    model: GEMINI_FLASH,
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096 },
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  const hunkBlock = hunks
    .map((h) => {
      const removed = h.lines.filter((l) => l.type === "removed").map((l) => l.text).join("\n");
      const added = h.lines.filter((l) => l.type === "added").map((l) => l.text).join("\n");
      return `## hunk ${h.index}\n--- 削除 ---\n${removed || "(なし)"}\n--- 追加 ---\n${added || "(なし)"}`;
    })
    .join("\n\n");
  const findingsBlock = findings.length
    ? findings.map((f) => `- [${f.axis}/${f.severity}] 「${f.quote}」: ${f.reason}`).join("\n")
    : "(指摘なし)";

  const prompt = `改稿の指示: ${feedback?.trim() || "(指示なし)"}

直前バージョンの試験指摘:
${findingsBlock}

変更箇所:
${hunkBlock}`;

  const result = await model.generateContent([{ text: prompt }]);
  return parseHunkReasons(result.response.text(), hunks.length);
}
```

- [ ] **Step 4: Run — verify offline passes (live skips)**

Run: `npx tsx scripts/test-screenplay-diff.ts`
Expected: `10 pass, 0 fail, 1 skip` (live `explainChanges` skipped without key).

- [ ] **Step 5: tsc check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/change-rationale.ts scripts/test-screenplay-diff.ts
git commit -m "feat(screenplay): change-rationale (per-hunk AI why) + parse"
```

---

## Task 5: Migration — `change_notes` column

**Files:** Create `supabase/migrations/2026-06-16_screenplay_version_change_notes.sql`

- [ ] **Step 1: Author the migration**

Create `supabase/migrations/2026-06-16_screenplay_version_change_notes.sql`:
```sql
-- Version-diff AI rationale cache. Written success-only by
-- GET /api/screenplays/[id]/versions/[versionId]/changes; shape = ChangeNotes
-- ({ ok, key, rationale, computedAt }). No RLS change: screenplay_versions is
-- already gated and the route reads/writes via the service client.
alter table screenplay_versions
  add column if not exists change_notes jsonb;
```

- [ ] **Step 2: Apply it manually**

This repo has no `db:push`/CLI migration runner — apply the SQL in the Supabase SQL editor (or your usual manual path). Then verify:

Run: `npm run test:migrations`
Expected: the migrations check passes (no missing-migration error for `change_notes`). If `test:migrations` does not assert columns, manually confirm: `select change_notes from screenplay_versions limit 1;` succeeds.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-06-16_screenplay_version_change_notes.sql
git commit -m "feat(screenplay): migration — screenplay_versions.change_notes"
```

---

## Task 6: Changes endpoint

**Files:** Create `app/api/screenplays/[id]/versions/[versionId]/changes/route.ts`

- [ ] **Step 1: Create the route**

```ts
// app/api/screenplays/[id]/versions/[versionId]/changes/route.ts
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { computeLineDiff, DIFF_VERSION } from "@/lib/screenplay/diff";
import { explainChanges, PROMPT_VERSION } from "@/lib/screenplay/change-rationale";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import type { ChangeNotes, ChangeNotesKey } from "@/lib/screenplay/types";
import type { Finding, ScriptCheckResult } from "@/lib/screenplay/compliance/types";

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flattenFindings(r: ScriptCheckResult | null): Finding[] {
  if (!r) return [];
  return [...(r.legal ?? []), ...(r.facts ?? []), ...(r.quality ?? [])].slice(0, 30);
}

function keysEqual(a: ChangeNotesKey, b: ChangeNotesKey): boolean {
  return (
    a.diffVersion === b.diffVersion &&
    a.promptVersion === b.promptVersion &&
    a.model === b.model &&
    a.baseVersionId === b.baseVersionId &&
    a.baseCheckId === b.baseCheckId &&
    a.hunkCount === b.hunkCount
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id, versionId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(versionId)) {
    return Response.json({ error: "invalid id" }, { status: 404 });
  }

  const sb = getServiceClient();

  const { data: v } = await sb
    .from("screenplay_versions")
    .select("id, markdown, base_version_id, feedback, change_notes")
    .eq("id", versionId)
    .eq("screenplay_id", id)
    .maybeSingle();
  if (!v) return Response.json({ error: "version not found" }, { status: 404 });
  if (!v.base_version_id) return Response.json({ error: "version has no base to compare" }, { status: 404 });

  const { data: parent } = await sb
    .from("screenplay_versions")
    .select("id, markdown")
    .eq("id", v.base_version_id)
    .eq("screenplay_id", id) // base must belong to the same screenplay
    .maybeSingle();
  if (!parent) return Response.json({ error: "base version not found in this screenplay" }, { status: 404 });

  const { data: checkRow } = await sb
    .from("screenplay_version_checks")
    .select("id, result")
    .eq("version_id", parent.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const findings = flattenFindings((checkRow?.result as ScriptCheckResult) ?? null);
  const baseCheckId: string | null = checkRow?.id ?? null;

  const diff = computeLineDiff(parent.markdown as string, v.markdown as string);
  const key: ChangeNotesKey = {
    diffVersion: DIFF_VERSION,
    promptVersion: PROMPT_VERSION,
    model: GEMINI_FLASH,
    baseVersionId: parent.id as string,
    baseCheckId,
    hunkCount: diff.length,
  };

  const cached = v.change_notes as ChangeNotes | null;
  if (cached?.ok && keysEqual(cached.key, key)) {
    return Response.json({ rationale: cached.rationale, model: key.model, computedAt: cached.computedAt });
  }

  try {
    const rationale = await explainChanges(diff, (v.feedback as string | null) ?? null, findings);
    const computedAt = new Date().toISOString();
    const notes: ChangeNotes = { ok: true, key, rationale, computedAt };
    await sb.from("screenplay_versions").update({ change_notes: notes }).eq("id", versionId);
    return Response.json({ rationale, model: key.model, computedAt });
  } catch (err) {
    // Do NOT cache failures — leave change_notes as-is so the next view retries.
    console.error("[screenplays/changes] rationale failed:", err instanceof Error ? err.message : String(err));
    return Response.json({ rationale: [], model: key.model, computedAt: null });
  }
}
```

- [ ] **Step 2: tsc + lint**

Run: `npx tsc --noEmit && npx eslint "app/api/screenplays/[id]/versions/[versionId]/changes/route.ts"`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "app/api/screenplays/[id]/versions/[versionId]/changes/route.ts"
git commit -m "feat(screenplay): version changes endpoint (diff rationale + cache)"
```

---

## Task 7: Refine base-version guard

**Files:** Modify `app/api/screenplays/[id]/refine/route.ts`

- [ ] **Step 1: Read the current base resolution**

Open `app/api/screenplays/[id]/refine/route.ts`. The current block is:
```ts
	const base = baseVersionId ?? sp.current_version_id;
	if (!base) {
		return Response.json(
			{ error: "no base version to refine from" },
			{ status: 400 },
		);
	}
```

- [ ] **Step 2: Add the ownership guard**

Replace that block with:
```ts
	const base = baseVersionId ?? sp.current_version_id;
	if (!base) {
		return Response.json(
			{ error: "no base version to refine from" },
			{ status: 400 },
		);
	}
	// Guard: an explicitly-supplied baseVersionId must belong to THIS screenplay,
	// so the base_version_id chain (used by the diff feature) can never point at
	// another screenplay's version.
	if (baseVersionId) {
		const { data: baseRow } = await supabase
			.from("screenplay_versions")
			.select("id")
			.eq("id", baseVersionId)
			.eq("screenplay_id", id)
			.maybeSingle();
		if (!baseRow) {
			return Response.json(
				{ error: "base version does not belong to this screenplay" },
				{ status: 400 },
			);
		}
	}
```
(`supabase` is already the `getServiceClient()` in scope in this handler.)

- [ ] **Step 3: tsc check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "app/api/screenplays/[id]/refine/route.ts"
git commit -m "fix(screenplay): refine rejects a base version from another screenplay"
```

---

## Task 8: `ChangeDiffView` component

**Files:** Create `components/screenplay/ChangeDiffView.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Lightbulb } from "lucide-react";
import { computeLineDiff } from "@/lib/screenplay/diff";
import type { HunkReason } from "@/lib/screenplay/types";

interface Props {
	baseMarkdown: string;
	markdown: string;
	screenplayId: string;
	versionId: string;
}

export function ChangeDiffView({ baseMarkdown, markdown, screenplayId, versionId }: Props) {
	const hunks = useMemo(() => computeLineDiff(baseMarkdown, markdown), [baseMarkdown, markdown]);
	const [reasons, setReasons] = useState<Record<number, string>>({});
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (hunks.length === 0) return;
		let cancelled = false;
		setLoading(true);
		fetch(`/api/screenplays/${screenplayId}/versions/${versionId}/changes`, { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((j: { rationale?: HunkReason[] }) => {
				if (cancelled) return;
				const m: Record<number, string> = {};
				for (const x of j.rationale ?? []) m[x.index] = x.reason;
				setReasons(m);
			})
			.catch(() => { /* diff still renders; reasons just stay empty */ })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [screenplayId, versionId, hunks.length]);

	if (hunks.length === 0) {
		return <p className="text-sm text-muted-foreground py-10 text-center">直前バージョンとの違いはありません。</p>;
	}

	return (
		<div className="space-y-5">
			{hunks.map((h) => (
				<div key={h.index} className="rounded-lg border border-border overflow-hidden">
					<div className="px-3 py-2 bg-muted/50 border-b border-border flex items-center gap-2 text-xs">
						<Lightbulb size={13} className="text-amber-500 shrink-0" />
						{reasons[h.index] ? (
							<span className="text-foreground">{reasons[h.index]}</span>
						) : loading ? (
							<span className="inline-flex items-center gap-1 text-muted-foreground">
								<Loader2 size={11} className="animate-spin" />
								理由を生成中…
							</span>
						) : (
							<span className="text-muted-foreground">文体・表現の調整</span>
						)}
					</div>
					<pre className="text-xs leading-relaxed overflow-x-auto p-3 m-0 font-mono whitespace-pre-wrap">
						{h.lines.map((l, i) => (
							<div
								key={i}
								className={
									l.type === "added"
										? "bg-green-600/10 text-green-800 dark:text-green-200"
										: l.type === "removed"
										? "bg-red-600/10 text-red-800 dark:text-red-200 line-through"
										: "text-muted-foreground"
								}
							>
								<span className="select-none opacity-60 mr-2">
									{l.type === "added" ? "＋" : l.type === "removed" ? "－" : "　"}
								</span>
								{l.text || " "}
							</div>
						))}
					</pre>
				</div>
			))}
		</div>
	);
}
```

- [ ] **Step 2: tsc + lint**

Run: `npx tsc --noEmit && npx eslint components/screenplay/ChangeDiffView.tsx`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/screenplay/ChangeDiffView.tsx
git commit -m "feat(screenplay): ChangeDiffView (inline diff + per-hunk 理由)"
```

---

## Task 9: `ScreenplayViewer` 「変更点」 toggle

**Files:** Modify `components/screenplay/ScreenplayViewer.tsx`

- [ ] **Step 1: Imports + props**

In `components/screenplay/ScreenplayViewer.tsx`:

(a) Change the icon import line:
```tsx
import { Copy, Download, Check, ChevronLeft, ChevronRight, FileText } from "lucide-react";
```
to:
```tsx
import { Copy, Download, Check, ChevronLeft, ChevronRight, FileText, GitCompare } from "lucide-react";
import { ChangeDiffView } from "./ChangeDiffView";
```

(b) Extend the `Props` interface — add after `nextLabel?: string;`:
```tsx
	baseMarkdown?: string;
	screenplayId?: string;
	versionId?: string;
```

(c) Add to the destructured params (after `nextLabel,`):
```tsx
	baseMarkdown,
	screenplayId,
	versionId,
```

- [ ] **Step 2: Toggle state + diff body**

(a) After `const [docxBusy, setDocxBusy] = useState(false);` add:
```tsx
	const [showDiff, setShowDiff] = useState(false);
	const canDiff = !!(baseMarkdown && screenplayId && versionId);
```

(b) In the toolbar, insert a toggle button as the first child of the right-hand action group — change:
```tsx
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={copyMd}
```
to:
```tsx
					<div className="flex items-center gap-1">
						{canDiff && (
							<button
								type="button"
								onClick={() => setShowDiff((v) => !v)}
								className={[
									"inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md transition-colors",
									showDiff ? "bg-blue-600/15 text-blue-700 dark:text-blue-300" : "text-foreground hover:bg-muted",
								].join(" ")}
							>
								<GitCompare size={12} />
								{showDiff ? "完成版" : "変更点"}
							</button>
						)}
						<button
							type="button"
							onClick={copyMd}
```

(c) Replace the body block:
```tsx
				<div className="px-6 py-8 lg:px-10 lg:py-10">
					<ScreenplayMarkdown markdown={markdown} />
				</div>
```
with:
```tsx
				<div className="px-6 py-8 lg:px-10 lg:py-10">
					{showDiff && canDiff ? (
						<ChangeDiffView
							baseMarkdown={baseMarkdown!}
							markdown={markdown}
							screenplayId={screenplayId!}
							versionId={versionId!}
						/>
					) : (
						<ScreenplayMarkdown markdown={markdown} />
					)}
				</div>
```

- [ ] **Step 3: tsc + lint**

Run: `npx tsc --noEmit && npx eslint components/screenplay/ScreenplayViewer.tsx`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add components/screenplay/ScreenplayViewer.tsx
git commit -m "feat(screenplay): 変更点 toggle in the viewer"
```

---

## Task 10: Wire parent markdown from `ScreenplayWorkspace`

**Files:** Modify `components/screenplay/ScreenplayWorkspace.tsx`

- [ ] **Step 1: Compute + pass parent markdown**

In `components/screenplay/ScreenplayWorkspace.tsx`, find the `<ScreenplayViewer ... />` usage. The current call is:
```tsx
						<ScreenplayViewer
							markdown={selected.markdown}
							title={initialScreenplay.title}
							versionLabel={`第 ${selected.version_number} 稿`}
							createdAt={selected.created_at}
							hasPrev={!!prev}
							hasNext={!!next}
							onPrev={goPrev}
							onNext={goNext}
							prevLabel={prev ? `v${pad(prev.version_number, 2)}` : undefined}
							nextLabel={next ? `v${pad(next.version_number, 2)}` : undefined}
						/>
```
Replace it with (adds the three diff props; `baseMarkdown` is the markdown of the version this one was refined from):
```tsx
						<ScreenplayViewer
							markdown={selected.markdown}
							title={initialScreenplay.title}
							versionLabel={`第 ${selected.version_number} 稿`}
							createdAt={selected.created_at}
							hasPrev={!!prev}
							hasNext={!!next}
							onPrev={goPrev}
							onNext={goNext}
							prevLabel={prev ? `v${pad(prev.version_number, 2)}` : undefined}
							nextLabel={next ? `v${pad(next.version_number, 2)}` : undefined}
							baseMarkdown={
								selected.base_version_id
									? versions.find((vv) => vv.id === selected.base_version_id)?.markdown
									: undefined
							}
							screenplayId={initialScreenplay.id}
							versionId={selected.id}
						/>
```

- [ ] **Step 2: tsc + lint**

Run: `npx tsc --noEmit && npx eslint components/screenplay/ScreenplayWorkspace.tsx`
Expected: clean. (`versions` and `selected` are already in scope; `ScreenplayVersionRow` includes `base_version_id`.)

- [ ] **Step 3: Commit**

```bash
git add components/screenplay/ScreenplayWorkspace.tsx
git commit -m "feat(screenplay): pass parent markdown to the viewer for diff"
```

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check, lint, diff tests**

Run:
```bash
npx tsc --noEmit && npm run lint && npx tsx scripts/test-screenplay-diff.ts
```
Expected: tsc clean; lint shows only pre-existing unrelated problems (none of the new/modified screenplay files); `test:screenplay-diff` → `10 pass, 0 fail, 1 skip` (live skipped under plain tsx without the env file).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: build succeeds; `/api/screenplays/[id]/versions/[versionId]/changes` appears in the route list; `diff` bundles into the client (ChangeDiffView) without error.

- [ ] **Step 3: Live diff test (with key, optional locally)**

Run: `npm run test:screenplay-diff`
Expected: `11 pass, 0 fail, 0 skip` IF the env's `GEMINI_API_KEY` has quota; locally the key is zero-quota so this stays `10 pass, 1 skip / 1 fail` — verify on a deployed preview/prod instead.

- [ ] **Step 4: Manual walkthrough (deployed or dev with a working key)**

1. Open a screenplay that has ≥2 versions (refine an existing one to create v2).
2. Select v2 → the toolbar shows a 「変更点」 toggle (hidden on v1).
3. Toggle on → the changed regions render (added green / removed red strikethrough) with `💡 理由` per hunk (spinner → reason); unrelated changes read 文体・表現の調整.
4. Toggle off → back to 完成版.
5. Reload → the rationale loads instantly (cache hit, no second Gemini call).
6. Confirm a finding-driven change (e.g. a 景表法 fix) shows a reason grounded in that finding.

- [ ] **Step 5: Final review request**

Use `superpowers:requesting-code-review` (or `/code-review`) on the branch diff. Focus: the cache-key validation + success-only persistence, the cross-screenplay base guards, and the client/server hunk-index alignment.

---

## Self-Review Notes (author)

- **Spec coverage:** diff.ts → Task 3; change-rationale (+throw-on-failure) → Task 4; types → Task 2; endpoint (parent guard, cache key, success-only) → Task 6; refine guard → Task 7; migration → Task 5; viewer toggle → Task 9; workspace wiring → Task 10; `diff` dep → Task 1; testing → Tasks 3/4/11. All spec sections covered.
- **Type consistency:** `DiffHunk{index,lines}`, `DiffLine{type,text}`, `HunkReason{index,reason}`, `ChangeNotesKey`, `ChangeNotes{ok,key,rationale,computedAt}`, `computeLineDiff`, `DIFF_VERSION`, `explainChanges`/`parseHunkReasons`/`PROMPT_VERSION`, `keysEqual`/`flattenFindings` — names consistent across Tasks 2/3/4/6 and the components.
- **No-change & failure paths:** `computeLineDiff` → `[]` (ChangeDiffView shows "違いはありません"); rationale failure → `{rationale:[]}`, not cached, retried; cross-screenplay base → 404/400.
