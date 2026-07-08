# Analysis-driven Revision Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-in-the-loop revision step to the screenplay produce UI — compliance findings (`試験結果`) become an AI-generated revision plan the operator edits/selects, merges with free feedback, and applies via the existing `/refine` pipeline.

**Architecture:** One new pure module (`revision-plan.ts`, injected-LLM like `check.ts`/`remediate.ts`) turns a `ScriptCheckResult` into a `RevisionPlan` and composes the operator's selection + free feedback into a single Japanese `feedback` string. A thin new POST route generates the plan. A new `RevisionPlanPanel` replaces `FeedbackForm` in the `개정` tab and submits through the unchanged `/refine` endpoint. No DB schema change.

**Tech Stack:** Next.js App Router (route handlers), next-intl, Supabase (`getServiceClient`), Google Gemini (`callGemini`), React client components, tsx smoke tests.

## Global Constraints

- **AI prompts written in English** (the revision-plan LLM prompt). Prompt output content is Japanese.
- **Stay-Japanese, NOT i18n'd** (hardcoded constants / runtime LLM data): plan body (`instruction`/`target`), compose headers `【考査結果に基づく修正方針】` / `【追加のご要望】`, axis labels `法規` / `事実` / `構成`, domain terms `試験結果` / `第N稿`.
- **i18n key parity**: `messages/ja.json` ≡ `messages/ko.json` keys, enforced by `npx tsx scripts/check-message-parity.ts`. New keys are all scalar.
- **Auth**: new route uses `requireUser(["member","admin"])` + `getServiceClient()` + explicit version→screenplay scoping (`.eq("id",versionId).eq("screenplay_id",id)`). RLS is role-only; do NOT rely on RLS for ownership.
- **`/refine` 4000-char cap**: `refine/route.ts:32` rejects `feedback.length > 4000`. The composed string MUST be capped client-side. `/refine` itself is NOT modified.
- **No DB schema change.** No new table. The composed plan lives only in the resulting `第2稿`'s `feedback` column.
- **lib imports are relative** (`./types`, `./compliance/types`); app/components use `@/`.
- **`revision-plan.ts` must NOT `import "server-only"`** — the tsx smoke imports it directly.
- **No test framework**: gates are `npx tsc --noEmit`, `npm run lint`, the tsx smoke, `scripts/check-message-parity.ts`, and `npm run build`. Pure logic (Tasks 1–2) is TDD'd via the smoke; route/UI (Tasks 3–6) are gated by tsc/lint/build (no runtime component tests exist in this repo).

---

## File Structure

- **Create** `lib/screenplay/revision-plan.ts` — `RevisionPlanItem`/`RevisionPlan` types, `buildRevisionPlan` (LLM + deterministic fallback + tolerant JSON parse/coerce), `composeRefineFeedback` (axis→JP map, verbatim-quote rule, 4000-char severity-priority cap).
- **Create** `scripts/test-screenplay-revision-plan.ts` — DB-free smoke with a fake `callLLM`.
- **Create** `app/api/screenplays/[id]/versions/[versionId]/revision-plan/route.ts` — POST endpoint.
- **Create** `components/screenplay/use-refine-submit.ts` — shared `/refine` submit hook (single POST location).
- **Create** `components/screenplay/RevisionPlanPanel.tsx` — plan UI + manual feedback + submit.
- **Modify** `messages/ja.json` + `messages/ko.json` — add `screenplay.review.plan.*`.
- **Modify** `components/screenplay/ReviewPanel.tsx` — render `RevisionPlanPanel` in the `refine` tab.
- **Delete** `components/screenplay/FeedbackForm.tsx` — superseded (its `screenplay.feedback.*` message keys stay; they are reused by `RevisionPlanPanel`).
- **Modify** `package.json` — add `test:screenplay-revision-plan` alias.

---

### Task 1: `revision-plan.ts` — plan generation + fallback

**Files:**
- Create: `lib/screenplay/revision-plan.ts`
- Create: `scripts/test-screenplay-revision-plan.ts`
- Modify: `package.json` (scripts section)

**Interfaces:**
- Consumes: `ProductBrief` from `./types`; `Finding`, `ScriptCheckResult` from `./compliance/types`.
- Produces:
  - `type LlmCall = (prompt: string) => Promise<string>`
  - `interface RevisionPlanItem { axis: "legal"|"facts"|"quality"; severity: "high"|"med"|"low"; target: string; instruction: string }`
  - `interface RevisionPlan { items: RevisionPlanItem[] }`
  - `function fallbackPlan(check: ScriptCheckResult): RevisionPlan`
  - `async function buildRevisionPlan(markdown: string, brief: ProductBrief, check: ScriptCheckResult, callLLM: LlmCall): Promise<RevisionPlan>`

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/test-screenplay-revision-plan.ts`:

```ts
/**
 * Unit test for the revision-plan engine. buildRevisionPlan + fallback are pure
 * (LLM injected as a fake). composeRefineFeedback is pure. No DB / no network.
 * Run: npm run test:screenplay-revision-plan
 */
import assert from "node:assert";
import {
	buildRevisionPlan,
	fallbackPlan,
	type RevisionPlanItem,
} from "../lib/screenplay/revision-plan";
import type { Finding, ScriptCheckResult } from "../lib/screenplay/compliance/types";
import type { ProductBrief } from "../lib/screenplay/types";

const brief: ProductBrief = { name: "テスト枕", description: "快眠まくら", category: "枕" };

const finding = (o: Partial<Finding>): Finding => ({
	axis: "legal", severity: "high", quote: "", reason: "", citedRule: "",
	suggestedRewrite: "", source: "llm", ...o,
});
const check = (legal: Finding[], facts: Finding[], quality: Finding[]): ScriptCheckResult => ({
	overallScore: 62, legal, facts, quality,
});

async function main() {
	// 1. Valid LLM JSON is used verbatim (after coercion).
	const fakeLLM: (p: string) => Promise<string> = async () =>
		JSON.stringify({ items: [
			{ axis: "legal", severity: "high", target: "業界No.1", instruction: "根拠不明のため削除" },
			{ axis: "quality", severity: "med", target: "", instruction: "実演デモを終盤へ移動" },
		] });
	const p1 = await buildRevisionPlan(
		"本日は業界No.1の枕。", brief,
		check([finding({ quote: "業界No.1", suggestedRewrite: "削除" })], [], [finding({ axis: "quality", severity: "med", reason: "CTA不足" })]),
		fakeLLM,
	);
	assert.equal(p1.items.length, 2, "p1 length");
	assert.equal(p1.items[0].axis, "legal");
	assert.equal(p1.items[1].instruction, "実演デモを終盤へ移動");

	// 2. Code-fence / prose-wrapped JSON still parses.
	const fencedLLM: (p: string) => Promise<string> = async () =>
		"ここが方針です:\n```json\n" + JSON.stringify({ items: [{ axis: "facts", severity: "low", target: "売上3億", instruction: "表現を緩和" }] }) + "\n```";
	const p2 = await buildRevisionPlan("台本", brief, check([], [finding({ axis: "facts" })], []), fencedLLM);
	assert.equal(p2.items.length, 1, "p2 length");
	assert.equal(p2.items[0].axis, "facts");

	// 3. Items with empty instruction AND empty target are dropped.
	const dirtyLLM: (p: string) => Promise<string> = async () =>
		JSON.stringify({ items: [ { axis: "legal", severity: "high", target: "", instruction: "" }, { axis: "legal", severity: "high", target: "x", instruction: "直す" } ] });
	const p3 = await buildRevisionPlan("台本 x", brief, check([finding({})], [], []), dirtyLLM);
	assert.equal(p3.items.length, 1, "p3 drops empty item");

	// 4. LLM throw → deterministic fallback from findings, NO axis prefix.
	const throwLLM: (p: string) => Promise<string> = async () => { throw new Error("boom"); };
	const p4 = await buildRevisionPlan("台本", brief, check([finding({ quote: "必ず痩せる", suggestedRewrite: "薬機法配慮で緩和" })], [], []), throwLLM);
	assert.equal(p4.items.length, 1, "p4 fallback length");
	assert.equal(p4.items[0].instruction, "薬機法配慮で緩和");
	assert.ok(!p4.items[0].instruction.startsWith("["), "fallback instruction has no axis prefix");

	// 5. LLM returns empty items → fallback; empty suggestedRewrite → reason.
	const emptyLLM: (p: string) => Promise<string> = async () => JSON.stringify({ items: [] });
	const p5 = await buildRevisionPlan("台本", brief, check([finding({ quote: "q", reason: "r" })], [], []), emptyLLM);
	assert.equal(p5.items.length, 1, "p5 fallback on empty");
	assert.equal(p5.items[0].instruction, "r");

	// 6. Zero findings → empty plan, LLM never consulted.
	const p6 = await buildRevisionPlan("台本", brief, check([], [], []), throwLLM);
	assert.equal(p6.items.length, 0, "p6 empty plan");

	// fallbackPlan direct
	const fb = fallbackPlan(check([finding({ quote: "a", suggestedRewrite: "b" })], [], []));
	assert.equal(fb.items[0].target, "a");
	assert.equal(fb.items[0].instruction, "b");

	console.log("revision-plan buildRevisionPlan/fallback: OK");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Add to `package.json` scripts (place next to the other `test:screenplay-*` aliases):

```json
"test:screenplay-revision-plan": "tsx scripts/test-screenplay-revision-plan.ts",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:screenplay-revision-plan`
Expected: FAIL — `Cannot find module '../lib/screenplay/revision-plan'` (module not created yet).

- [ ] **Step 3: Implement `revision-plan.ts` (plan generation half)**

Create `lib/screenplay/revision-plan.ts`:

```ts
// lib/screenplay/revision-plan.ts
// Analysis-driven revision plan. PURE w.r.t. the LLM: the synthesis model call
// is injected as `callLLM`, so this module is unit-testable with a fake. The
// route passes the real Gemini caller. Deterministic fallback keeps the plan
// step working even when the LLM is unavailable (e.g. zero-quota local key).
//
// Do NOT `import "server-only"` here — a tsx smoke imports this module directly.

import type { ProductBrief } from "./types";
import type { Finding, ScriptCheckResult } from "./compliance/types";

export type LlmCall = (prompt: string) => Promise<string>;

export interface RevisionPlanItem {
	axis: "legal" | "facts" | "quality";
	severity: "high" | "med" | "low";
	target: string;       // verbatim JP quote when possible; a location description for structural items.
	instruction: string;  // JP: 何を・なぜ・どう直すか. NO axis prefix (compose owns the label).
}
export interface RevisionPlan { items: RevisionPlanItem[] }

const MARKDOWN_SLICE = 12000;
const AXES: RevisionPlanItem["axis"][] = ["legal", "facts", "quality"];
const SEVS: RevisionPlanItem["severity"][] = ["high", "med", "low"];

// Tolerant JSON extraction — mirror of check.ts::parseJSON (code-fence / prose
// wrapping tolerated, balanced-brace scan).
function parseJSON<T>(raw: string): T {
	let c = raw.trim();
	const fence = c.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fence) c = fence[1].trim();
	const start = c.indexOf("{");
	if (start === -1) throw new Error("No JSON object found");
	let depth = 0, inStr = false, esc = false, end = -1;
	for (let i = start; i < c.length; i++) {
		const ch = c[i];
		if (esc) { esc = false; continue; }
		if (ch === "\\") { esc = true; continue; }
		if (ch === '"') { inStr = !inStr; continue; }
		if (inStr) continue;
		if (ch === "{") depth++;
		else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
	}
	if (end === -1) throw new Error("Unbalanced JSON");
	return JSON.parse(c.slice(start, end + 1)) as T;
}

function coerceItem(raw: unknown): RevisionPlanItem | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const axis = AXES.includes(r.axis as RevisionPlanItem["axis"]) ? (r.axis as RevisionPlanItem["axis"]) : null;
	if (!axis) return null;
	const severity = SEVS.includes(r.severity as RevisionPlanItem["severity"]) ? (r.severity as RevisionPlanItem["severity"]) : "med";
	const target = String(r.target ?? "").trim().slice(0, 300);
	const instruction = String(r.instruction ?? "").trim().slice(0, 300);
	if (!instruction && !target) return null;
	return { axis, severity, target, instruction };
}

// Deterministic fallback: build straight from findings. NO axis prefix on
// instruction — the compose step (composeRefineFeedback) owns the label, so a
// prefix here would double-label.
export function fallbackPlan(check: ScriptCheckResult): RevisionPlan {
	const all: Finding[] = [...check.legal, ...check.facts, ...check.quality];
	const items: RevisionPlanItem[] = [];
	for (const f of all) {
		const target = (f.quote || "").trim().slice(0, 300);
		const instruction = (f.suggestedRewrite || f.reason || "").trim().slice(0, 300);
		if (!target && !instruction) continue;
		items.push({ axis: f.axis, severity: f.severity, target, instruction });
	}
	return { items };
}

function buildPrompt(markdown: string, brief: ProductBrief, check: ScriptCheckResult): string {
	const line = (f: Finding) =>
		`- [${f.axis}/${f.severity}] quote: ${JSON.stringify(f.quote)} | reason: ${f.reason} | suggestedRewrite: ${f.suggestedRewrite}`;
	const findings = [...check.legal, ...check.facts, ...check.quality].map(line).join("\n") || "(none)";
	return `You are a Japanese TV-shopping ("考査") reviewer. Synthesize the compliance findings below into a concise, DE-DUPLICATED, prioritized revision plan for the script. Merge near-duplicate findings across axes. For quality-axis findings, turn them into concrete structural directives (e.g. move a section). Output PURE JSON only — no markdown, no prose.

The plan drives a JAPANESE script regeneration, so every "instruction" and "target" MUST be written in Japanese. Do NOT prefix "instruction" with the axis. Keep each item short and actionable. Use a verbatim quote from the script for "target" when the finding points at specific text; for a structural change, put a brief location description in "target".

Product: ${brief.name} / category: ${brief.category ?? "(unknown)"}
Score: ${check.overallScore}/100
Findings:
${findings}

Script (truncated):
${markdown.slice(0, MARKDOWN_SLICE)}

Output exactly this shape:
{"items":[{"axis":"legal|facts|quality","severity":"high|med|low","target":"...","instruction":"..."}]}`;
}

export async function buildRevisionPlan(
	markdown: string,
	brief: ProductBrief,
	check: ScriptCheckResult,
	callLLM: LlmCall,
): Promise<RevisionPlan> {
	const findingCount = check.legal.length + check.facts.length + check.quality.length;
	if (findingCount === 0) return { items: [] };
	try {
		const raw = await callLLM(buildPrompt(markdown, brief, check));
		const parsed = parseJSON<{ items?: unknown[] }>(raw);
		const items = (parsed.items ?? []).map(coerceItem).filter((x): x is RevisionPlanItem => x !== null);
		if (items.length === 0) return fallbackPlan(check);
		return { items };
	} catch (err) {
		console.warn("[revision-plan] LLM synthesis failed, using deterministic fallback:", err instanceof Error ? err.message : String(err));
		return fallbackPlan(check);
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:screenplay-revision-plan`
Expected: PASS — prints `revision-plan buildRevisionPlan/fallback: OK`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors in `lib/screenplay/revision-plan.ts` or the smoke. (Pre-existing unrelated errors in `app/api/cron/archive-videos` from uninstalled native deps may appear — ignore those.)

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/revision-plan.ts scripts/test-screenplay-revision-plan.ts package.json
git commit -m "feat(screenplay): revision-plan generator (LLM + deterministic fallback)"
```

---

### Task 2: `composeRefineFeedback` — selection + free feedback → capped JP string

**Files:**
- Modify: `lib/screenplay/revision-plan.ts` (append compose logic)
- Modify: `scripts/test-screenplay-revision-plan.ts` (append compose tests)

**Interfaces:**
- Consumes: `RevisionPlanItem` (Task 1).
- Produces:
  - `interface ComposeResult { feedback: string; includedCount: number; trimmedCount: number }`
  - `function composeRefineFeedback(items: RevisionPlanItem[], freeFeedback: string, markdown: string): ComposeResult`

- [ ] **Step 1: Add failing compose tests**

Append to `scripts/test-screenplay-revision-plan.ts` — add the import and a second test body, and call it from `main`:

```ts
// add to the import from ../lib/screenplay/revision-plan:
//   buildRevisionPlan, fallbackPlan, composeRefineFeedback, type RevisionPlanItem

async function composeTests() {
	const md = "本日は業界No.1の枕をご紹介。売上3億の実績。";

	// verbatim target → 「…」→ ; non-verbatim target → instruction only
	const r1 = composeRefineFeedback(
		[
			{ axis: "legal", severity: "high", target: "業界No.1", instruction: "削除" },
			{ axis: "quality", severity: "med", target: "", instruction: "実演デモを終盤へ移動" },
		],
		"テンポを速く", md,
	);
	assert.ok(r1.feedback.includes("【考査結果に基づく修正方針】"), "r1 has plan header");
	assert.ok(r1.feedback.includes("[法規] 「業界No.1」→ 削除"), "r1 verbatim legal item");
	assert.ok(r1.feedback.includes("[構成] 実演デモを終盤へ移動"), "r1 structural item, no quote wrap");
	assert.ok(!r1.feedback.includes("「実演デモを終盤へ移動」"), "r1 structural not quote-wrapped");
	assert.ok(r1.feedback.includes("【追加のご要望】") && r1.feedback.includes("テンポを速く"), "r1 free feedback appended");
	assert.equal(r1.trimmedCount, 0, "r1 no trim");

	// non-verbatim target (absent from md) → instruction only
	const r2 = composeRefineFeedback([{ axis: "facts", severity: "low", target: "存在しない語", instruction: "緩和" }], "", md);
	assert.ok(r2.feedback.includes("[事実] 緩和"), "r2 instruction only");
	assert.ok(!r2.feedback.includes("「存在しない語」"), "r2 no quote for absent target");

	// 4000-char cap: high-severity kept, low trimmed, free feedback preserved
	const bigLow = (i: number): RevisionPlanItem => ({ axis: "quality", severity: "low", target: "", instruction: `低${i}`.padEnd(500, "あ") });
	const many: RevisionPlanItem[] = [
		...Array.from({ length: 8 }, (_, i) => bigLow(i)),
		{ axis: "legal", severity: "high", target: "", instruction: "重要削除99" },
	];
	const r3 = composeRefineFeedback(many, "自由入力メモ", md);
	assert.ok(r3.feedback.length <= 4000, "r3 within cap");
	assert.ok(r3.feedback.includes("自由入力メモ"), "r3 free feedback preserved");
	assert.ok(r3.feedback.includes("重要削除99"), "r3 high-severity item kept");
	assert.ok(r3.trimmedCount > 0, "r3 some items trimmed");

	// no items → free feedback only, no plan header
	const r4 = composeRefineFeedback([], "自由だけ", md);
	assert.equal(r4.feedback, "自由だけ", "r4 free-only");
	assert.equal(r4.includedCount, 0, "r4 no items");

	console.log("revision-plan composeRefineFeedback: OK");
}
```

And in `main`, add `await composeTests();` before the final `console.log`/`process.exit` (i.e. call it after the buildRevisionPlan asserts).

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:screenplay-revision-plan`
Expected: FAIL — `composeRefineFeedback` is not exported (`TypeError` / import undefined).

- [ ] **Step 3: Implement `composeRefineFeedback`**

Append to `lib/screenplay/revision-plan.ts`:

```ts
// ── Compose: selection + free feedback → a single JP /refine feedback string ──
// These constants are Japanese CONTENT fed to the JP generator and persisted to
// the version's `feedback` column — intentionally NOT i18n'd.
const AXIS_JP: Record<RevisionPlanItem["axis"], string> = {
	legal: "法規",
	facts: "事実",
	quality: "構成",
};
const SEV_RANK: Record<RevisionPlanItem["severity"], number> = { high: 0, med: 1, low: 2 };
const MAX_FEEDBACK = 4000; // mirror of app/api/screenplays/[id]/refine/route.ts:32
const PLAN_HEADER = "【考査結果に基づく修正方針】";
const FEEDBACK_HEADER = "【追加のご要望】";

export interface ComposeResult {
	feedback: string;
	includedCount: number;
	trimmedCount: number;
}

function renderItem(n: number, item: RevisionPlanItem, markdown: string): string {
	const label = AXIS_JP[item.axis];
	const verbatim = item.target.length > 0 && markdown.includes(item.target);
	return verbatim
		? `${n}. [${label}] 「${item.target}」→ ${item.instruction}`
		: `${n}. [${label}] ${item.instruction}`;
}

function composePlan(items: RevisionPlanItem[], freeBlock: string, markdown: string): string {
	const body = items.map((it, i) => renderItem(i + 1, it, markdown)).join("\n");
	return `${PLAN_HEADER}\n${body}${freeBlock}`;
}

export function composeRefineFeedback(
	items: RevisionPlanItem[],
	freeFeedback: string,
	markdown: string,
): ComposeResult {
	const free = freeFeedback.trim();
	const freeBlock = free ? `\n${FEEDBACK_HEADER}\n${free}` : "";

	// Trim least-severe first so a length overflow drops low before high.
	const sorted = [...items].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
	const included: RevisionPlanItem[] = [];
	for (const item of sorted) {
		if (composePlan([...included, item], freeBlock, markdown).length > MAX_FEEDBACK) break;
		included.push(item);
	}

	const trimmedCount = items.length - included.length;
	const feedback = included.length > 0
		? composePlan(included, freeBlock, markdown)
		: free; // nothing fit / nothing selected → free text only (may exceed cap; that's the user's own input)
	return { feedback, includedCount: included.length, trimmedCount };
}
```

Also update the smoke's import line at the top of `scripts/test-screenplay-revision-plan.ts` to include `composeRefineFeedback`:

```ts
import {
	buildRevisionPlan,
	fallbackPlan,
	composeRefineFeedback,
	type RevisionPlanItem,
} from "../lib/screenplay/revision-plan";
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:screenplay-revision-plan`
Expected: PASS — prints both `buildRevisionPlan/fallback: OK` and `composeRefineFeedback: OK`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/revision-plan.ts scripts/test-screenplay-revision-plan.ts
git commit -m "feat(screenplay): composeRefineFeedback (axis→JP, verbatim rule, 4000-char cap)"
```

---

### Task 3: POST `revision-plan` route

**Files:**
- Create: `app/api/screenplays/[id]/versions/[versionId]/revision-plan/route.ts`

**Interfaces:**
- Consumes: `buildRevisionPlan` (Task 1); `callGemini`, `loadActiveRules`, `loadActiveReferences`, `checkScreenplay` from `@/lib/screenplay/compliance/check`.
- Produces: `POST` responds `{ plan: RevisionPlan, basedOnScore: number, findingCount: number }`.

- [ ] **Step 1: Implement the route**

Create `app/api/screenplays/[id]/versions/[versionId]/revision-plan/route.ts`:

```ts
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import {
	loadActiveRules,
	loadActiveReferences,
	checkScreenplay,
	callGemini,
} from "@/lib/screenplay/compliance/check";
import { buildRevisionPlan } from "@/lib/screenplay/revision-plan";
import type { ProductBrief } from "@/lib/screenplay/types";
import type { ScriptCheckResult } from "@/lib/screenplay/compliance/types";

export const maxDuration = 90; // may run an on-demand check + plan synthesis (2 serial Gemini calls)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string; versionId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id, versionId } = await params;
	if (!UUID_RE.test(id) || !UUID_RE.test(versionId)) {
		return Response.json({ error: "invalid id" }, { status: 404 });
	}

	const supabase = getServiceClient();

	const { data: sp, error: spErr } = await supabase
		.from("screenplays")
		.select("id, product_info_snapshot")
		.eq("id", id)
		.maybeSingle();
	if (spErr) return Response.json({ error: spErr.message }, { status: 500 });
	if (!sp) return Response.json({ error: "screenplay not found" }, { status: 404 });

	// Version must belong to THIS screenplay (RLS is role-only; scope explicitly).
	const { data: ver, error: verErr } = await supabase
		.from("screenplay_versions")
		.select("id, markdown")
		.eq("id", versionId)
		.eq("screenplay_id", id)
		.maybeSingle();
	if (verErr) return Response.json({ error: verErr.message }, { status: 500 });
	if (!ver) return Response.json({ error: "version not found" }, { status: 404 });

	const brief = sp.product_info_snapshot as ProductBrief;
	const markdown = (ver as unknown as { markdown: string }).markdown;

	// Latest persisted check for this version, else run corpus-only on demand
	// (factSearch=false → no Brave egress). The on-demand check is NOT persisted.
	let check: ScriptCheckResult;
	const { data: checkRow } = await supabase
		.from("screenplay_version_checks")
		.select("result")
		.eq("version_id", versionId)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (checkRow?.result) {
		check = checkRow.result as ScriptCheckResult;
	} else {
		const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
		check = await checkScreenplay(markdown, brief, rules, references, { factSearch: false });
	}

	const plan = await buildRevisionPlan(markdown, brief, check, callGemini);
	const findingCount = check.legal.length + check.facts.length + check.quality.length;
	return Response.json({ plan, basedOnScore: check.overallScore, findingCount });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors for the new route file. (Confirms `callGemini`, `loadActiveRules`, `loadActiveReferences`, `checkScreenplay` are exported by `check.ts` with the expected signatures.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors for the new route file.

- [ ] **Step 4: Commit**

```bash
git add "app/api/screenplays/[id]/versions/[versionId]/revision-plan/route.ts"
git commit -m "feat(screenplay): POST revision-plan route (owned-version scope, on-demand corpus check)"
```

> Note: this repo has no route test framework and local `GEMINI_API_KEY` is zero-quota; runtime verification of this endpoint happens in a deployed env. The pure logic it calls is covered by Task 1–2 smoke.

---

### Task 4: i18n keys (`screenplay.review.plan.*`)

**Files:**
- Modify: `messages/ja.json` (add `plan` under `screenplay.review`)
- Modify: `messages/ko.json` (add `plan` under `screenplay.review`)

**Interfaces:**
- Produces: message keys consumed by `RevisionPlanPanel` (Task 5): `screenplay.review.plan.{proposeBtn,regenerate,generating,failed,heading,basedOnScore,emptyNoFindings,applyBtn,itemsTrimmed,manualHeading}`.

- [ ] **Step 1: Add keys to `messages/ja.json`**

Inside the existing `screenplay.review` object, add a `"plan"` key:

```json
"plan": {
	"heading": "修正方針",
	"proposeBtn": "試験結果から修正方針を提案",
	"regenerate": "再提案",
	"generating": "方針を生成中…",
	"failed": "修正方針の生成に失敗しました",
	"basedOnScore": "試験結果 {score}点 · 指摘 {count}件",
	"emptyNoFindings": "指摘がないため修正方針は不要です。下に直接ご要望を書いて修正できます。",
	"manualHeading": "個別のご要望（任意）",
	"itemsTrimmed": "{count}件の項目が長さ制限で除外されました",
	"applyBtn": "この方針で修正"
}
```

- [ ] **Step 2: Add the SAME keys to `messages/ko.json`**

Inside the existing `screenplay.review` object, add:

```json
"plan": {
	"heading": "개정 방침",
	"proposeBtn": "試験結果로 개정 방침 제안",
	"regenerate": "다시 제안",
	"generating": "방침 생성 중…",
	"failed": "개정 방침 생성에 실패했습니다",
	"basedOnScore": "試験結果 {score}점 · 지적 {count}건",
	"emptyNoFindings": "지적이 없어 개정 방침이 필요하지 않습니다. 아래에 직접 요청을 적어 개정할 수 있습니다.",
	"manualHeading": "직접 요청(선택)",
	"itemsTrimmed": "{count}개 항목이 길이 제한으로 제외되었습니다",
	"applyBtn": "이 방침으로 개정"
}
```

- [ ] **Step 3: Verify key parity**

Run: `npx tsx scripts/check-message-parity.ts`
Expected: PASS — `OK — N keys match` (N = previous count + 10).

- [ ] **Step 4: Commit**

```bash
git add messages/ja.json messages/ko.json
git commit -m "i18n(screenplay): add review.plan.* keys (ja≡ko)"
```

---

### Task 5: `use-refine-submit` hook + `RevisionPlanPanel`

**Files:**
- Create: `components/screenplay/use-refine-submit.ts`
- Create: `components/screenplay/RevisionPlanPanel.tsx`

**Interfaces:**
- Consumes: `composeRefineFeedback`, `RevisionPlanItem` from `@/lib/screenplay/revision-plan`; `screenplay.review.plan.*` (Task 4); existing `screenplay.feedback.*`, `screenplay.review.{axisLegal,axisFacts,axisQuality,sevHigh,sevMed,sevLow}`, `screenplay.errors.refineFailed`.
- Produces:
  - `function useRefineSubmit(screenplayId: string, baseVersionId: string, onStart: (runId: string) => void): { submit: (feedback: string) => Promise<void>; busy: boolean; err: string | null; setErr: (v: string | null) => void }`
  - `function RevisionPlanPanel(props: { screenplayId: string; versionId: string; markdown: string; disabled?: boolean; onRefineStart: (runId: string) => void }): JSX.Element`

- [ ] **Step 1: Implement the shared submit hook**

Create `components/screenplay/use-refine-submit.ts`:

```ts
"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";

// Single source of truth for the POST /refine call (shared so the composed
// plan submit and any manual submit use the exact same request).
export function useRefineSubmit(
	screenplayId: string,
	baseVersionId: string,
	onStart: (runId: string) => void,
) {
	const tErr = useTranslations("screenplay.errors");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function submit(feedback: string) {
		const fb = feedback.trim();
		if (!fb) return;
		setBusy(true);
		setErr(null);
		try {
			const res = await fetch(`/api/screenplays/${screenplayId}/refine`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: fb, baseVersionId }),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? tErr("refineFailed"));
			onStart(j.runId as string);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return { submit, busy, err, setErr };
}
```

- [ ] **Step 2: Implement `RevisionPlanPanel`**

Create `components/screenplay/RevisionPlanPanel.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Send, Sparkles, Wand2, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { composeRefineFeedback, type RevisionPlanItem } from "@/lib/screenplay/revision-plan";
import { useRefineSubmit } from "./use-refine-submit";

interface Props {
	screenplayId: string;
	versionId: string;
	markdown: string;
	disabled?: boolean;
	onRefineStart: (runId: string) => void;
}

const AXIS_KEY: Record<RevisionPlanItem["axis"], string> = {
	legal: "review.axisLegal",
	facts: "review.axisFacts",
	quality: "review.axisQuality",
};
const SEV_KEY: Record<RevisionPlanItem["severity"], string> = {
	high: "review.sevHigh",
	med: "review.sevMed",
	low: "review.sevLow",
};
const SEV_CLS: Record<RevisionPlanItem["severity"], string> = {
	high: "bg-red-600/15 text-red-700 dark:text-red-300",
	med: "bg-yellow-600/15 text-yellow-700 dark:text-yellow-300",
	low: "bg-blue-600/15 text-blue-700 dark:text-blue-300",
};

export function RevisionPlanPanel({ screenplayId, versionId, markdown, disabled, onRefineStart }: Props) {
	const t = useTranslations("screenplay");
	const suggestions = t.raw("feedback.suggestions") as string[];
	const { submit, busy, err, setErr } = useRefineSubmit(screenplayId, versionId, onRefineStart);

	const [items, setItems] = useState<RevisionPlanItem[] | null>(null);
	const [selected, setSelected] = useState<boolean[]>([]);
	const [findingCount, setFindingCount] = useState<number | null>(null);
	const [basedOnScore, setBasedOnScore] = useState<number | null>(null);
	const [planLoading, setPlanLoading] = useState(false);
	const [planErr, setPlanErr] = useState<string | null>(null);
	const [freeText, setFreeText] = useState("");
	const [trimmed, setTrimmed] = useState(0);

	// Stale-drop: clear plan state on version switch; drop in-flight responses
	// so a plan generated for 第N稿 can't be composed against a switched-to base.
	const versionRef = useRef(versionId);
	useEffect(() => {
		versionRef.current = versionId;
		setItems(null); setSelected([]); setFindingCount(null); setBasedOnScore(null);
		setPlanErr(null); setFreeText(""); setTrimmed(0); setErr(null);
	}, [versionId, setErr]);

	async function propose() {
		const reqVersion = versionId;
		setPlanLoading(true);
		setPlanErr(null);
		setTrimmed(0);
		try {
			const res = await fetch(`/api/screenplays/${screenplayId}/versions/${versionId}/revision-plan`, { method: "POST" });
			const j = (await res.json()) as { plan?: { items: RevisionPlanItem[] }; basedOnScore?: number; findingCount?: number; error?: string };
			if (!res.ok) throw new Error(j.error ?? t("review.plan.failed"));
			if (reqVersion !== versionRef.current) return;
			const its = j.plan?.items ?? [];
			setItems(its);
			setSelected(its.map(() => true));
			setFindingCount(j.findingCount ?? 0);
			setBasedOnScore(j.basedOnScore ?? null);
		} catch (e) {
			if (reqVersion === versionRef.current) setPlanErr(e instanceof Error ? e.message : String(e));
		} finally {
			if (reqVersion === versionRef.current) setPlanLoading(false);
		}
	}

	function toggle(i: number) {
		setSelected((s) => s.map((v, idx) => (idx === i ? !v : v)));
	}

	function onApply() {
		const chosen = (items ?? []).filter((_, i) => selected[i]);
		const { feedback, trimmedCount } = composeRefineFeedback(chosen, freeText, markdown);
		setTrimmed(trimmedCount);
		if (!feedback.trim()) return;
		void submit(feedback);
	}

	const hasSelection = selected.some(Boolean);
	const canApply = !disabled && !busy && (hasSelection || freeText.trim().length > 0);

	return (
		<Card className="border-border">
			<CardContent className="p-5 space-y-4">
				{/* Plan generation */}
				<div>
					<div className="flex items-center justify-between mb-2">
						<div className="flex items-center gap-2">
							<div className="w-8 h-8 bg-blue-600/10 rounded-lg flex items-center justify-center">
								<ShieldCheck size={16} className="text-blue-600" />
							</div>
							<div>
								<h3 className="text-sm font-semibold text-foreground">{t("review.plan.heading")}</h3>
								{basedOnScore != null && findingCount != null && (
									<p className="text-[11px] text-muted-foreground">{t("review.plan.basedOnScore", { score: basedOnScore, count: findingCount })}</p>
								)}
							</div>
						</div>
						<button
							type="button"
							onClick={propose}
							disabled={disabled || planLoading}
							className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-border rounded-lg hover:border-blue-200 hover:bg-blue-600/10 text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{planLoading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
							{planLoading ? t("review.plan.generating") : items ? t("review.plan.regenerate") : t("review.plan.proposeBtn")}
						</button>
					</div>

					{planErr && (
						<div className="mb-2 p-2.5 bg-red-600/10 border border-red-200 dark:border-red-900/40 rounded-lg text-xs text-red-700 dark:text-red-300">{planErr}</div>
					)}

					{items && items.length === 0 && (
						<p className="text-xs text-muted-foreground py-2">{t("review.plan.emptyNoFindings")}</p>
					)}

					{items && items.length > 0 && (
						<div className="space-y-2">
							{items.map((it, i) => (
								<label key={i} className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-xs cursor-pointer hover:bg-muted/50">
									<input type="checkbox" checked={selected[i] ?? false} onChange={() => toggle(i)} className="mt-0.5" />
									<span className="flex-1 min-w-0 space-y-1">
										<span className="flex items-center gap-1.5">
											<span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{t(AXIS_KEY[it.axis])}</span>
											<span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${SEV_CLS[it.severity]}`}>{t(SEV_KEY[it.severity])}</span>
										</span>
										{it.target && <span className="block text-muted-foreground break-all">「{it.target}」</span>}
										<span className="block text-foreground">{it.instruction}</span>
									</span>
								</label>
							))}
						</div>
					)}
				</div>

				{/* Manual feedback */}
				<div className="border-t border-border pt-4">
					<div className="flex items-center gap-2 mb-2">
						<Sparkles size={14} className="text-blue-600" />
						<h4 className="text-sm font-semibold text-foreground">{t("review.plan.manualHeading")}</h4>
					</div>
					<textarea
						value={freeText}
						onChange={(e) => setFreeText(e.target.value)}
						rows={4}
						disabled={disabled || busy}
						placeholder={t("feedback.placeholder")}
						className="w-full px-3 py-2.5 text-sm border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none"
					/>
					<div className="mt-2">
						<div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t("feedback.frequentRequests")}</div>
						<div className="space-y-1.5">
							{suggestions.map((s) => (
								<button
									key={s}
									type="button"
									onClick={() => setFreeText((v) => (v ? v + "\n" : "") + s)}
									className="w-full text-left text-xs px-3 py-2 border border-border rounded-lg hover:border-blue-200 hover:bg-blue-600/10 text-foreground transition-colors"
								>
									<span className="text-blue-500 mr-1.5">＋</span>{s}
								</button>
							))}
						</div>
					</div>
				</div>

				{trimmed > 0 && (
					<p className="text-[11px] text-yellow-700 dark:text-yellow-300">{t("review.plan.itemsTrimmed", { count: trimmed })}</p>
				)}
				{err && (
					<div className="p-2.5 bg-red-600/10 border border-red-200 dark:border-red-900/40 rounded-lg text-xs text-red-700 dark:text-red-300">{err}</div>
				)}

				<button
					type="button"
					onClick={onApply}
					disabled={!canApply}
					className="w-full inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
					{busy ? t("feedback.sending") : t("review.plan.applyBtn")}
				</button>
			</CardContent>
		</Card>
	);
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: no new errors in the two new files.
Run: `npm run lint`
Expected: clean for the two new files.

- [ ] **Step 4: Commit**

```bash
git add components/screenplay/use-refine-submit.ts components/screenplay/RevisionPlanPanel.tsx
git commit -m "feat(screenplay): RevisionPlanPanel + shared useRefineSubmit hook"
```

---

### Task 6: Wire into `ReviewPanel`, remove `FeedbackForm`, verify build

**Files:**
- Modify: `components/screenplay/ReviewPanel.tsx`
- Delete: `components/screenplay/FeedbackForm.tsx`

**Interfaces:**
- Consumes: `RevisionPlanPanel` (Task 5).

- [ ] **Step 1: Swap the `refine` tab content**

In `components/screenplay/ReviewPanel.tsx`, replace the `FeedbackForm` import and usage.

Change the import:

```tsx
// remove:
import { FeedbackForm } from "./FeedbackForm";
// add:
import { RevisionPlanPanel } from "./RevisionPlanPanel";
```

Replace the `refine` TabsContent body:

```tsx
<TabsContent value="refine">
	<RevisionPlanPanel
		screenplayId={screenplayId}
		versionId={version.id}
		markdown={version.markdown}
		disabled={isGenerating}
		onRefineStart={onRefineStart}
	/>
</TabsContent>
```

(The old body was `<FeedbackForm screenplayId={screenplayId} baseVersionId={version.id} disabled={isGenerating} onStart={onRefineStart} />`.)

- [ ] **Step 2: Confirm `FeedbackForm` is now unused, then delete it**

Run: `grep -rn "FeedbackForm" components app --include=*.tsx --include=*.ts`
Expected: no matches remain (only the file itself, if the grep runs before deletion). If any OTHER file imports `FeedbackForm`, STOP and report — do not delete.

Then delete the file:

```bash
git rm components/screenplay/FeedbackForm.tsx
```

> The `screenplay.feedback.*` message keys are still used by `RevisionPlanPanel` — do NOT remove them.

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: no new errors.
Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds for all screenplay/produce routes. (Pre-existing unrelated failures from uninstalled native deps in `app/api/cron/archive-videos` — `@aws-sdk/client-s3`, `@ffmpeg-installer/ffmpeg` — are environmental and NOT caused by this change; confirm any failure is limited to those modules.)

- [ ] **Step 5: Re-run the smoke + parity (final gate)**

Run: `npm run test:screenplay-revision-plan`
Expected: PASS.
Run: `npx tsx scripts/check-message-parity.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/screenplay/ReviewPanel.tsx
git commit -m "feat(screenplay): wire RevisionPlanPanel into 개정 tab, remove FeedbackForm"
```

---

## Self-Review

**Spec coverage:**
- 방침 생성 모듈(LLM+폴백) → Task 1. compose(axis→JP, verbatim, 4000 cap) → Task 2. 엔드포인트(getServiceClient+loadOwnedVersion scope, on-demand corpus check, maxDuration 90) → Task 3. i18n plan keys(ja≡ko, scalar) → Task 4. UI(방침 제안 + 항목 토글 + 자유 피드백 + suggestion chips + stale-drop + 단일 submit hook) → Task 5. ReviewPanel 배선 + FeedbackForm 제거 → Task 6. 모든 spec §4~§8 항목이 태스크에 매핑됨.
- Edge cases (spec §5): findings=0 (Task 1 p6 + Task 5 empty state), no prior check (Task 3 corpus fallback), LLM fail (Task 1 p4 fallback), 4000 overflow (Task 2 r3), version switch (Task 5 versionRef), verbatim mismatch (Task 2 r2 instruction-only), concurrent refine (delegated to existing /refine CAS — unchanged).

**Placeholder scan:** No TBD/TODO. Every code step shows full code; every command lists expected output.

**Type consistency:** `RevisionPlanItem`/`RevisionPlan`/`LlmCall`/`ComposeResult` defined in Tasks 1–2 and consumed with identical names/shapes in Tasks 3 & 5. Route response `{ plan, basedOnScore, findingCount }` matches the panel's `propose()` parse. Hook signature `useRefineSubmit(screenplayId, baseVersionId, onStart)` matches its call in Task 5. i18n keys added in Task 4 match every `t("review.plan.*")` usage in Task 5.
