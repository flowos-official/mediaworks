# Screenplay Detail — Wide 2-pane Review Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/[locale]/screenplays/[id]` from a cramped 3-column grid into a wide 2-pane layout — script (left) + a tabbed 検証 panel (試験結果 | 変更点 | 改稿) on the right — with a full-width top action bar and independently-scrolling panes.

**Architecture:** A full-width sticky `ScreenplayHeaderBar` (version nav + copy/export) sits above a responsive grid: history rail (xl) / script pane / tabbed `ReviewPanel`. Each pane scrolls independently with a sticky, viewport-bounded height. The 試験結果 tab becomes version-aware via a new per-version check API; `CheckResultPanel` refetches on version change instead of freezing its initial prop.

**Tech Stack:** Next.js 16 App Router, React 19 (client components), TypeScript, Tailwind CSS 4, base-ui Tabs (`components/ui/tabs.tsx`), Supabase (`@supabase/ssr` + service client), `lucide-react`.

## Global Constraints

- API routes: `requireUser(["member","admin"])` at top; `getServiceClient()` for DB (RLS-bypass behind the role gate) — established screenplay-route pattern.
- Tenant scoping: every version/check query filters `.eq("screenplay_id", id)` (mirror `versions/[versionId]/changes/route.ts`).
- UUID validation on all `id`/`versionId` route params (`/^[0-9a-f]{8}-...$/i`).
- Distinguish "no row" (`200 { check: null }`) from failure (`404` ownership / `500 { error }`).
- v1 does NOT change `(produce)/layout.tsx` `max-w-7xl`. Width is solved by the top-bar + 2-pane restructure only.
- Korean stage/UI copy stays as-is where it exists; new Japanese UI copy matches surrounding screens.
- Verification per task: `npx tsc --noEmit` clean + `npm run lint` clean. Final: `npm run build` + browser E2E on deploy. Local `GEMINI_API_KEY` is zero-quota → Gemini-dependent paths (check POST) verified on deploy, not locally.
- Each task ends with a commit.

---

## File Structure

- Create `app/api/screenplays/[id]/versions/[versionId]/check/route.ts` — per-version check GET/POST.
- Create `scripts/test-version-check-api.ts` — skip-guarded live DB smoke for the per-version check query semantics.
- Create `components/screenplay/ScreenplayHeaderBar.tsx` — full-width top bar (version nav + コピー/.md/Word).
- Create `components/screenplay/ReviewPanel.tsx` — tabbed right pane (試験結果 | 変更点 | 改稿).
- Modify `components/screenplay/CheckResultPanel.tsx` — version-aware (props + useEffect refetch/reset + onCheckChange).
- Modify `components/screenplay/ScreenplayViewer.tsx` — slim to scrollable body; remove toolbar + diff toggle.
- Modify `components/screenplay/ScreenplayWorkspace.tsx` — new shell, tab state, wiring, version-aware handleComplete.
- Modify `package.json` scripts — add `test:version-check`.

---

## Task 1: Per-version check API + smoke

**Files:**
- Create: `app/api/screenplays/[id]/versions/[versionId]/check/route.ts`
- Create: `scripts/test-version-check-api.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `GET /api/screenplays/:id/versions/:versionId/check` → `200 { check: CheckWithMeta | null }`, `404 { error }` (bad id / not owned), `500 { error }`.
- Produces: `POST` (same path) → re-checks that version → `200 { check: CheckWithMeta }`, `404`/`500`.
- `CheckWithMeta` = `ScriptCheckResult & { id, created_at, is_auto, lexicon_version }` (same shape the existing `[id]/check` GET returns).
- Consumes: `loadActiveRules`, `loadActiveReferences`, `checkScreenplay` from `@/lib/screenplay/compliance/check`; `ProductBrief` from `@/lib/screenplay/types`.

- [ ] **Step 1: Write the route**

Create `app/api/screenplays/[id]/versions/[versionId]/check/route.ts`. Mirror `app/api/screenplays/[id]/check/route.ts` but scope by `versionId` and validate ownership (`.eq("id", versionId).eq("screenplay_id", id)`):

```ts
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { loadActiveRules, loadActiveReferences, checkScreenplay } from "@/lib/screenplay/compliance/check";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Loads the version row only if it belongs to the screenplay (tenant scope).
async function loadOwnedVersion(
	supabase: ReturnType<typeof getServiceClient>,
	id: string,
	versionId: string,
	columns: string,
) {
	const { data, error } = await supabase
		.from("screenplay_versions")
		.select(columns)
		.eq("id", versionId)
		.eq("screenplay_id", id)
		.maybeSingle();
	return { data, error };
}

// GET: latest check for THIS version. 200 {check:null} when none; 404 when the
// version is not found / not owned by this screenplay; 500 on query failure.
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

	const supabase = getServiceClient();
	const { data: ver, error: verErr } = await loadOwnedVersion(supabase, id, versionId, "id");
	if (verErr) return Response.json({ error: verErr.message }, { status: 500 });
	if (!ver) return Response.json({ error: "version not found" }, { status: 404 });

	const { data, error } = await supabase
		.from("screenplay_version_checks")
		.select("id, overall_score, result, created_at, is_auto, lexicon_version")
		.eq("version_id", versionId)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (error) return Response.json({ error: error.message }, { status: 500 });
	if (!data) return Response.json({ check: null });

	return Response.json({
		check: {
			id: data.id,
			created_at: data.created_at,
			is_auto: data.is_auto,
			lexicon_version: data.lexicon_version ?? undefined,
			...(data.result as object),
		},
	});
}

// POST: re-check THIS version on demand.
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

	const { data: ver, error: verErr } = await loadOwnedVersion(supabase, id, versionId, "id, markdown");
	if (verErr) return Response.json({ error: verErr.message }, { status: 500 });
	if (!ver) return Response.json({ error: "version not found" }, { status: 404 });

	const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
	const result = await checkScreenplay(
		(ver as { markdown: string }).markdown,
		sp.product_info_snapshot as ProductBrief,
		rules,
		references,
		{ factSearch: true },
	);

	const lexiconVersion = `rules:${rules.length} refs:${references.length} h:${result.grounding?.corpusHash ?? ""}`;
	const { data: inserted, error: insErr } = await supabase
		.from("screenplay_version_checks")
		.insert({
			version_id: versionId,
			overall_score: result.overallScore,
			result,
			lexicon_version: lexiconVersion,
			is_auto: false,
			created_by: auth.user.id,
		})
		.select("id, created_at")
		.single();
	if (insErr) return Response.json({ error: insErr.message }, { status: 500 });

	return Response.json({
		check: { id: inserted.id, created_at: inserted.created_at, is_auto: false, lexicon_version: lexiconVersion, ...result },
	});
}
```

- [ ] **Step 2: Write the skip-guarded DB smoke**

Create `scripts/test-version-check-api.ts`. It verifies the QUERY semantics the route relies on (ownership filter + latest-check fetch) directly against the DB — no Gemini, so it runs locally. Mirror the skip-guard style of `scripts/test-screenplay-diff.ts`.

```ts
import { getServiceClient } from "../lib/supabase";

let pass = 0, fail = 0, skip = 0;
function ok(name: string, cond: boolean, detail = "") {
	if (cond) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
	console.log("\n=== version-check API query semantics ===\n");
	const hasEnv = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.NEXT_PUBLIC_SUPABASE_URL;
	if (!hasEnv) { console.log("  ⏭ skip (no Supabase env)"); skip++; console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} skip ===`); return; }

	const sb = getServiceClient();

	// Pick two distinct screenplays each with >=1 version.
	const { data: sps } = await sb.from("screenplays").select("id").limit(5);
	if (!sps || sps.length < 1) { console.log("  ⏭ skip (no screenplays)"); skip++; console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} skip ===`); return; }

	const spA = sps[0].id;
	const { data: versA } = await sb.from("screenplay_versions").select("id").eq("screenplay_id", spA).limit(1);
	ok("screenplay A has a version", !!versA && versA.length > 0);
	if (!versA?.length) { console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} skip ===`); return; }
	const verA = versA[0].id;

	// Ownership filter: verA must resolve under spA, and NOT under a different screenplay id.
	const { data: owned } = await sb.from("screenplay_versions").select("id").eq("id", verA).eq("screenplay_id", spA).maybeSingle();
	ok("owned version resolves under its screenplay", !!owned && owned.id === verA);

	const otherSp = sps.find((s) => s.id !== spA)?.id ?? "00000000-0000-0000-0000-000000000000";
	const { data: notOwned } = await sb.from("screenplay_versions").select("id").eq("id", verA).eq("screenplay_id", otherSp).maybeSingle();
	ok("version is rejected under a different screenplay id", notOwned === null);

	// Latest-check fetch shape (may legitimately be null if never checked).
	const { data: chk, error: chkErr } = await sb
		.from("screenplay_version_checks")
		.select("id, overall_score, result, created_at, is_auto, lexicon_version")
		.eq("version_id", verA).order("created_at", { ascending: false }).limit(1).maybeSingle();
	ok("latest-check query runs without error", !chkErr, chkErr?.message);
	ok("check is null or has result object", chk === null || typeof chk.result === "object");

	console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} skip ===`);
	if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Add the script alias**

In `package.json` `scripts`, add (next to `test:screenplay-diff`):

```json
"test:version-check": "tsx --env-file=.env.local scripts/test-version-check-api.ts",
```

- [ ] **Step 4: Run smoke + tsc + lint**

Run: `npm run test:version-check`
Expected: `N pass, 0 fail` (or all-skip offline). 
Run: `npx tsc --noEmit` → exit 0.
Run: `npm run lint` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add "app/api/screenplays/[id]/versions/[versionId]/check/route.ts" scripts/test-version-check-api.ts package.json
git commit -m "feat(screenplay): per-version check API (GET/POST) + ownership smoke"
```

---

## Task 2: CheckResultPanel version-awareness

**Files:**
- Modify: `components/screenplay/CheckResultPanel.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/screenplays/:id/versions/:versionId/check` (Task 1).
- Produces: `CheckResultPanel` props become
  `{ screenplayId: string; versionId: string; initialCheck: CheckWithMeta | null; initialCheckVersionId: string | null; onCheckChange?: (check: CheckWithMeta | null) => void }`.

- [ ] **Step 1: Change Props + add version-aware fetch/reset**

In `components/screenplay/CheckResultPanel.tsx`:

Replace the `Props` interface:

```ts
interface Props {
	screenplayId: string;
	versionId: string;
	initialCheck: CheckWithMeta | null;
	initialCheckVersionId: string | null;
	onCheckChange?: (check: CheckWithMeta | null) => void;
}
```

Replace the component body's state + add the effect. The SSR `initialCheck` only applies when `versionId === initialCheckVersionId`; otherwise fetch:

```ts
export function CheckResultPanel({ screenplayId, versionId, initialCheck, initialCheckVersionId, onCheckChange }: Props) {
	const seeded = versionId === initialCheckVersionId;
	const [check, setCheck] = useState<CheckWithMeta | null>(seeded ? initialCheck : null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// Refetch when the selected version changes. The initial render for the
	// SSR-seeded version skips the fetch (uses initialCheck); every other
	// version fetches its own latest check and never shows a stale result.
	useEffect(() => {
		let cancelled = false;
		if (versionId === initialCheckVersionId) {
			setCheck(initialCheck);
			setErr(null);
			onCheckChange?.(initialCheck);
			return;
		}
		setLoading(true);
		setErr(null);
		setCheck(null);
		onCheckChange?.(null);
		(async () => {
			try {
				const res = await fetch(`/api/screenplays/${screenplayId}/versions/${versionId}/check`, { cache: "no-store" });
				const j = (await res.json()) as { check?: CheckWithMeta | null; error?: string };
				if (!res.ok) throw new Error(j.error ?? "試験結果の取得に失敗しました");
				if (cancelled) return;
				setCheck(j.check ?? null);
				onCheckChange?.(j.check ?? null);
			} catch (e) {
				if (cancelled) return;
				setCheck(null);
				onCheckChange?.(null);
				setErr(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [versionId]);
```

> Note: `useState`/`useEffect` must be imported — change line 2 to `import { useState, useEffect } from "react";`.

- [ ] **Step 2: Point recheck at the versioned endpoint + notify parent**

Replace the `recheck()` fetch URL and add the parent notification:

```ts
	async function recheck() {
		setBusy(true);
		setErr(null);
		try {
			const res = await fetch(`/api/screenplays/${screenplayId}/versions/${versionId}/check`, { method: "POST" });
			const j = await res.json() as { check?: CheckWithMeta; error?: string };
			if (!res.ok) throw new Error(j.error ?? "再チェックに失敗しました");
			setCheck(j.check ?? null);
			onCheckChange?.(j.check ?? null);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
```

- [ ] **Step 3: Show a loading state**

In the render, before the `{check ? (...) : (...)}` block, show a spinner while `loading`. Replace the final ternary with:

```tsx
				{loading ? (
					<p className="text-xs text-muted-foreground py-3 text-center flex items-center justify-center gap-2">
						<Loader2 size={12} className="animate-spin" /> 試験結果を読み込み中…
					</p>
				) : check ? (
					<>
						{/* ...existing score + AxisSection blocks unchanged... */}
					</>
				) : (
					<p className="text-xs text-muted-foreground py-3 text-center">
						「再チェック」で試験を実行してください。
					</p>
				)}
```

(Keep the existing score header, `AxisSection`, and `ReproducibilityInfo` exactly as-is inside the `check ?` branch.)

- [ ] **Step 4: tsc + lint**

Run: `npx tsc --noEmit` → exit 0. `npm run lint` → no new errors (watch `react-hooks/exhaustive-deps`; the disable comment is intentional and documented).

- [ ] **Step 5: Commit**

```bash
git add components/screenplay/CheckResultPanel.tsx
git commit -m "feat(screenplay): CheckResultPanel refetches per selected version"
```

---

## Task 3: ScreenplayHeaderBar + slim ScreenplayViewer

**Files:**
- Create: `components/screenplay/ScreenplayHeaderBar.tsx`
- Modify: `components/screenplay/ScreenplayViewer.tsx`

**Interfaces:**
- Produces: `ScreenplayHeaderBar` props
  `{ markdown: string; title: string; versionLabel?: string; createdAt?: string; hasPrev?: boolean; hasNext?: boolean; onPrev?: () => void; onNext?: () => void; prevLabel?: string; nextLabel?: string }`.
- Produces: `ScreenplayViewer` props reduce to `{ markdown: string }` (renders the scrollable body only).

- [ ] **Step 1: Create ScreenplayHeaderBar**

Move the toolbar (version nav + char count/date + コピー/.md/Word) out of the viewer into a full-width bar. Create `components/screenplay/ScreenplayHeaderBar.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Copy, Download, Check, ChevronLeft, ChevronRight, FileText } from "lucide-react";

interface Props {
	markdown: string;
	title: string;
	versionLabel?: string;
	createdAt?: string;
	hasPrev?: boolean;
	hasNext?: boolean;
	onPrev?: () => void;
	onNext?: () => void;
	prevLabel?: string;
	nextLabel?: string;
}

function pad(n: number, w: number): string { return n.toString().padStart(w, "0"); }
function formatStamp(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getFullYear()}/${pad(d.getMonth() + 1, 2)}/${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

export function ScreenplayHeaderBar({ markdown, title, versionLabel, createdAt, hasPrev, hasNext, onPrev, onNext, prevLabel, nextLabel }: Props) {
	const [copied, setCopied] = useState(false);
	const [docxBusy, setDocxBusy] = useState(false);
	const chars = markdown.length;
	const safeName = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}${versionLabel ? `-${versionLabel.replace(/\s+/g, "")}` : ""}`;

	function downloadMd() {
		const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a"); a.href = url; a.download = `${safeName}.md`; a.click();
		URL.revokeObjectURL(url);
	}
	async function downloadDocx() {
		setDocxBusy(true);
		try {
			const { buildScreenplayDocx } = await import("@/lib/screenplay/screenplay-docx");
			const blob = await buildScreenplayDocx(markdown, title);
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a"); a.href = url; a.download = `${safeName}.docx`; a.click();
			URL.revokeObjectURL(url);
		} finally { setDocxBusy(false); }
	}
	async function copyMd() {
		await navigator.clipboard.writeText(markdown);
		setCopied(true); setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div className="sticky top-16 z-20 flex items-center justify-between gap-3 bg-card/95 backdrop-blur-sm border border-border rounded-xl px-3 py-2 mb-4 flex-wrap">
			<div className="flex items-center gap-1">
				<button type="button" onClick={onPrev} disabled={!hasPrev}
					title={prevLabel ? `前のバージョン (第 ${prevLabel.replace("v", "")} 稿)` : "前のバージョン"}
					className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-foreground hover:bg-muted rounded-md disabled:text-muted-foreground disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors">
					<ChevronLeft size={14} /> 前へ
				</button>
				<button type="button" onClick={onNext} disabled={!hasNext}
					title={nextLabel ? `次のバージョン (第 ${nextLabel.replace("v", "")} 稿)` : "次のバージョン"}
					className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-foreground hover:bg-muted rounded-md disabled:text-muted-foreground disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors">
					次へ <ChevronRight size={14} />
				</button>
			</div>
			<div className="flex items-baseline gap-3 text-xs text-muted-foreground min-w-0">
				{versionLabel && <span className="font-semibold text-foreground whitespace-nowrap">{versionLabel}</span>}
				{createdAt && <span className="tabular-nums whitespace-nowrap">{formatStamp(createdAt)}</span>}
				<span className="tabular-nums whitespace-nowrap hidden sm:inline">{chars.toLocaleString()} 文字</span>
			</div>
			<div className="flex items-center gap-1">
				<button type="button" onClick={copyMd} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors">
					{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "コピー済み" : "コピー"}
				</button>
				<button type="button" onClick={downloadMd} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors">
					<Download size={12} /> .md
				</button>
				<button type="button" onClick={downloadDocx} disabled={docxBusy} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
					<FileText size={12} /> {docxBusy ? "生成中…" : "Word"}
				</button>
			</div>
		</div>
	);
}
```

- [ ] **Step 2: Slim ScreenplayViewer to the scrollable body**

Replace the entire contents of `components/screenplay/ScreenplayViewer.tsx` with the body-only version (removes the toolbar, all actions, and the `変更点/完成版` toggle + `ChangeDiffView` import):

```tsx
"use client";
import { Card } from "@/components/ui/card";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface Props {
	markdown: string;
}

export function ScreenplayViewer({ markdown }: Props) {
	return (
		<Card className="border-border overflow-hidden">
			<div className="px-6 py-8 lg:px-10 lg:py-10">
				<ScreenplayMarkdown markdown={markdown} />
			</div>
		</Card>
	);
}
```

- [ ] **Step 3: tsc**

Run: `npx tsc --noEmit`.
Expected: errors ONLY in `ScreenplayWorkspace.tsx` (it still passes the old props to `ScreenplayViewer`). That is expected and fixed in Task 5. Confirm no errors in `ScreenplayHeaderBar.tsx` / `ScreenplayViewer.tsx` themselves.

- [ ] **Step 4: Commit**

```bash
git add components/screenplay/ScreenplayHeaderBar.tsx components/screenplay/ScreenplayViewer.tsx
git commit -m "feat(screenplay): extract ScreenplayHeaderBar; slim viewer to body"
```

---

## Task 4: ReviewPanel (tabbed 試験結果 | 変更点 | 改稿)

**Files:**
- Create: `components/screenplay/ReviewPanel.tsx`

**Interfaces:**
- Consumes: `CheckResultPanel` (Task 2 props), `ChangeDiffView` (`{ baseMarkdown, markdown, screenplayId, versionId }`), `FeedbackForm` (`{ screenplayId, baseVersionId, disabled, onStart }`), `Tabs/TabsList/TabsTrigger/TabsContent` from `@/components/ui/tabs`.
- Consumes: `ScreenplayVersionRow` from `@/lib/screenplay/types`, `ScriptCheckResult` from `@/lib/screenplay/compliance/types`.
- Produces: `ReviewPanel` props
  `{ screenplayId: string; version: ScreenplayVersionRow; baseMarkdown?: string; initialCheck: CheckWithMeta | null; initialCheckVersionId: string | null; isGenerating: boolean; activeTab: ReviewTab; onTabChange: (t: ReviewTab) => void; onRefineStart: (runId: string) => void }`
  where `type ReviewTab = "check" | "diff" | "refine"`.

- [ ] **Step 1: Create ReviewPanel**

Create `components/screenplay/ReviewPanel.tsx`. Tab list is fixed at top; content scrolls. The 件数 badge is owned here via `onCheckChange`. The 変更点 tab stays enabled; the empty state lives in its content.

```tsx
"use client";
import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CheckResultPanel } from "./CheckResultPanel";
import { ChangeDiffView } from "./ChangeDiffView";
import { FeedbackForm } from "./FeedbackForm";
import type { ScreenplayVersionRow } from "@/lib/screenplay/types";
import type { ScriptCheckResult } from "@/lib/screenplay/compliance/types";

type CheckWithMeta = ScriptCheckResult & { created_at?: string; lexicon_version?: string };
export type ReviewTab = "check" | "diff" | "refine";

interface Props {
	screenplayId: string;
	version: ScreenplayVersionRow;
	baseMarkdown?: string;
	initialCheck: CheckWithMeta | null;
	initialCheckVersionId: string | null;
	isGenerating: boolean;
	activeTab: ReviewTab;
	onTabChange: (t: ReviewTab) => void;
	onRefineStart: (runId: string) => void;
}

export function ReviewPanel({
	screenplayId, version, baseMarkdown, initialCheck, initialCheckVersionId,
	isGenerating, activeTab, onTabChange, onRefineStart,
}: Props) {
	const [findingCount, setFindingCount] = useState<number | null>(null);
	const canDiff = !!(baseMarkdown && version.base_version_id);

	function handleCheckChange(c: CheckWithMeta | null) {
		setFindingCount(c ? c.legal.length + c.facts.length + c.quality.length : null);
	}

	return (
		<Tabs value={activeTab} onValueChange={(v) => onTabChange(v as ReviewTab)} className="gap-3">
			<TabsList className="w-full">
				<TabsTrigger value="check">
					試験結果{findingCount != null && findingCount > 0 ? ` (${findingCount})` : ""}
				</TabsTrigger>
				<TabsTrigger value="diff">変更点</TabsTrigger>
				<TabsTrigger value="refine">改稿</TabsTrigger>
			</TabsList>

			<TabsContent value="check">
				<CheckResultPanel
					screenplayId={screenplayId}
					versionId={version.id}
					initialCheck={initialCheck}
					initialCheckVersionId={initialCheckVersionId}
					onCheckChange={handleCheckChange}
				/>
			</TabsContent>

			<TabsContent value="diff">
				{canDiff ? (
					<ChangeDiffView
						baseMarkdown={baseMarkdown!}
						markdown={version.markdown}
						screenplayId={screenplayId}
						versionId={version.id}
					/>
				) : (
					<div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
						初稿のため比較対象がありません。
					</div>
				)}
			</TabsContent>

			<TabsContent value="refine">
				<FeedbackForm
					screenplayId={screenplayId}
					baseVersionId={version.id}
					disabled={isGenerating}
					onStart={onRefineStart}
				/>
			</TabsContent>
		</Tabs>
	);
}
```

- [ ] **Step 2: tsc**

Run: `npx tsc --noEmit`. Expected: still only the pre-existing `ScreenplayWorkspace.tsx` errors from Task 3 (fixed in Task 5). No errors inside `ReviewPanel.tsx`.

- [ ] **Step 3: Commit**

```bash
git add components/screenplay/ReviewPanel.tsx
git commit -m "feat(screenplay): tabbed ReviewPanel (試験結果 | 変更点 | 改稿)"
```

---

## Task 5: ScreenplayWorkspace shell + wiring + responsive

**Files:**
- Modify: `components/screenplay/ScreenplayWorkspace.tsx`
- Modify: `app/[locale]/(produce)/screenplays/[id]/page.tsx` (pass `initialCheckVersionId`)

**Interfaces:**
- Consumes: `ScreenplayHeaderBar` (Task 3), `ReviewPanel` + `ReviewTab` (Task 4), `ScreenplayViewer` (Task 3 slim).

- [ ] **Step 1: Pass initialCheckVersionId from the page**

In `app/[locale]/(produce)/screenplays/[id]/page.tsx`, the SSR `latestCheck` has no `version_id`. Pass the version it belongs to (`current_version_id`) into the workspace. Change the render line:

```tsx
<ScreenplayWorkspace
	initialScreenplay={screenplay}
	initialVersions={versions}
	latestCheck={latestCheck}
	initialCheckVersionId={screenplay.current_version_id ?? null}
/>
```

- [ ] **Step 2: Rewrite ScreenplayWorkspace layout + state + wiring**

In `components/screenplay/ScreenplayWorkspace.tsx`:

(a) Update imports — remove `FeedbackForm`/`CheckResultPanel` direct imports, add `ScreenplayHeaderBar`, `ReviewPanel`/`ReviewTab`:

```ts
import { ScreenplayHeaderBar } from "./ScreenplayHeaderBar";
import { ScreenplayViewer } from "./ScreenplayViewer";
import { ReviewPanel, type ReviewTab } from "./ReviewPanel";
```
(Delete the now-unused `FeedbackForm` and `CheckResultPanel` imports and the `Card`/`CardContent`/`FileText` imports only if they become unused — verify against the empty-state block below, which still uses `Card`/`CardContent`/`FileText`.)

(b) Add `initialCheckVersionId` to `Props`:

```ts
interface Props {
	initialScreenplay: ScreenplayRow;
	initialVersions: ScreenplayVersionRow[];
	latestCheck?: (ScriptCheckResult & { created_at?: string; lexicon_version?: string }) | null;
	initialCheckVersionId?: string | null;
}
```
and destructure `initialCheckVersionId = null` in the function signature.

(c) Add review-tab state (near the other `useState`s):

```ts
const [activeReviewTab, setActiveReviewTab] = useState<ReviewTab>("check");
```

(d) Make `handleComplete` version-aware — decide the tab from the **refreshed** row (the new version's `base_version_id` may be unknown at complete-time):

```ts
async function handleComplete(versionId: string) {
	setRunId(null);
	const list = await refreshListReturning(versionId);
	const v = list.find((x) => x.id === versionId);
	setActiveReviewTab(v?.base_version_id ? "diff" : "check");
	const params = new URLSearchParams(search);
	params.delete("run");
	params.delete("kind");
	router.replace(`?${params.toString()}`);
}
```

Add a `refreshListReturning` variant that returns the fetched versions (so the tab decision uses fresh data). Adapt the existing `refreshList`:

```ts
async function refreshListReturning(newSelectedId?: string): Promise<ScreenplayVersionRow[]> {
	const res = await fetch(`/api/screenplays/${initialScreenplay.id}`, { cache: "no-store" });
	if (!res.ok) return versions;
	const j = (await res.json()) as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
	setVersions(j.versions);
	setSelectedId(newSelectedId ?? j.screenplay.current_version_id ?? j.versions[j.versions.length - 1]?.id ?? null);
	return j.versions;
}
```
(Keep the existing `refreshList` for the mount-time poll effect, or have it delegate to `refreshListReturning`.)

(e) Replace the returned JSX. The grid becomes: full-width header bar on top, then a responsive `[history? | viewer | review]` row. History rail shows at `xl`; at `lg` it collapses (rendered above the panes as a compact selector — for v1 a simple `<select>` is acceptable). Both panes get sticky independent scroll at `lg+`:

```tsx
const baseMarkdown = selected?.base_version_id
	? versions.find((vv) => vv.id === selected.base_version_id)?.markdown
	: undefined;

return (
	<div>
		{selected && (
			<ScreenplayHeaderBar
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
		)}

		<div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] xl:grid-cols-[220px_minmax(0,1fr)_minmax(380px,440px)] gap-6">
			{/* HISTORY — xl rail; lg/sm compact selector */}
			<aside className="hidden xl:block xl:sticky xl:top-[7rem] self-start">
				<Card className="border-border">
					<CardContent className="p-4">
						<div className="flex items-center justify-between mb-3">
							<h2 className="text-sm font-semibold text-foreground">改稿履歴</h2>
							<span className="text-[11px] text-muted-foreground">{versions.length}件</span>
						</div>
						{versions.length > 0 ? (
							<VersionTimeline
								versions={versions.map((v) => ({ id: v.id, version_number: v.version_number, feedback: v.feedback, created_at: v.created_at }))}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						) : (
							<p className="text-xs text-muted-foreground py-4 text-center">まだ稿がありません</p>
						)}
						<div className="text-[11px] text-muted-foreground mt-4 pt-3 border-t border-border leading-relaxed">⌘← / ⌘→ で版を移動できます</div>
					</CardContent>
				</Card>
			</aside>

			{/* HISTORY — lg/sm dropdown (hidden at xl) */}
			{versions.length > 1 && (
				<div className="xl:hidden">
					<label className="text-[11px] font-medium text-muted-foreground mr-2">改稿履歴</label>
					<select
						value={selectedId ?? ""}
						onChange={(e) => setSelectedId(e.target.value)}
						className="text-sm border border-border rounded-lg px-2 py-1.5 bg-card"
					>
						{versions.map((v) => (
							<option key={v.id} value={v.id}>第 {v.version_number} 稿{v.feedback ? ` — ${v.feedback.slice(0, 24)}` : ""}</option>
						))}
					</select>
				</div>
			)}

			{/* CENTER — SCRIPT */}
			<section className="min-w-0 lg:sticky lg:top-[7rem] self-start lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
				{isGenerating && runId && (
					<div className="mb-4">
						<GenerationProgress runId={runId} onComplete={(versionId) => handleComplete(versionId)} variant={runVariant} />
					</div>
				)}
				{selected ? (
					<ScreenplayViewer markdown={selected.markdown} />
				) : !isGenerating ? (
					<Card className="border-border border-dashed">
						<CardContent className="py-16 flex flex-col items-center justify-center text-center">
							<div className="w-14 h-14 bg-muted rounded-full flex items-center justify-center mb-3">
								<FileText size={24} className="text-muted-foreground" />
							</div>
							<p className="text-sm text-foreground font-medium">まだ台本がありません</p>
							<p className="text-xs text-muted-foreground mt-1">右側のフォームから最初の台本を生成してください。</p>
						</CardContent>
					</Card>
				) : null}
			</section>

			{/* RIGHT — REVIEW PANEL */}
			<aside className="lg:sticky lg:top-[7rem] self-start lg:max-h-[calc(100vh-8rem)] overflow-y-auto min-h-0">
				{selected ? (
					<ReviewPanel
						screenplayId={initialScreenplay.id}
						version={selected}
						baseMarkdown={baseMarkdown}
						initialCheck={latestCheck ?? null}
						initialCheckVersionId={initialCheckVersionId}
						isGenerating={isGenerating}
						activeTab={activeReviewTab}
						onTabChange={setActiveReviewTab}
						onRefineStart={handleRefineStart}
					/>
				) : (
					<Card className="border-border">
						<CardContent className="p-5 text-center text-xs text-muted-foreground">最初の台本ができたら、ここで改稿できます。</CardContent>
					</Card>
				)}
			</aside>
		</div>
	</div>
);
```

> Keep `handleRefineStart`, `goPrev`/`goNext`, the keyboard effect, and the mount-time generating poll effect unchanged.

- [ ] **Step 3: tsc + lint**

Run: `npx tsc --noEmit` → exit 0 (all earlier task errors now resolved).
Run: `npm run lint` → no new errors. Remove any genuinely unused imports flagged.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success; the new route `screenplays/[id]/versions/[versionId]/check` registered; no type/lint failures.

- [ ] **Step 5: Commit**

```bash
git add components/screenplay/ScreenplayWorkspace.tsx "app/[locale]/(produce)/screenplays/[id]/page.tsx"
git commit -m "feat(screenplay): 2-pane detail layout — header bar + script + tabbed review"
```

---

## Final Verification (after Task 5)

- [ ] `npx tsc --noEmit` clean; `npm run lint` clean; `npm run build` succeeds.
- [ ] `npm run test:version-check` and `npm run test:screenplay-diff` pass (or all-skip offline).
- [ ] Browser E2E on deploy (local GEMINI is zero-quota): on the existing imported screenplay, refine → v2; verify:
  - top bar renders on one line, `コピー` no longer breaks vertically;
  - script pane and review pane scroll independently (review reachable without scrolling the script to the bottom);
  - tabs switch 試験結果 / 変更点 / 改稿; 変更点 shows inline diff + 理由 for v2; v1 shows "初稿のため比較対象なし";
  - switching version in history updates the 試験結果 to that version (no stale current-version findings);
  - after a refine completes, the panel auto-selects 変更点.

---

## Notes / Out of scope (per spec)

- No `(produce)/layout.tsx` `max-w-7xl` change in v1. Route-scoped widening is a follow-up.
- Finding → script-line jump/highlight; cross-version score trends; removal of the legacy `[id]/check` route — all follow-ups.
