# SessionCalendar Multi-Session Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every session of a day reachable from the `/[locale]/analytics/discovery/history` calendar by replacing the single-target day cell `<Link>` with a Base UI Popover that lists all sessions for that day, and adding a `+N` overflow indicator when a day has more than 4 sessions.

**Architecture:** A single component (`components/discovery/SessionCalendar.tsx`) is rewritten. Each day cell with sessions becomes a Base UI `Popover.Trigger` button; opening it reveals a list of `<Link>` rows — one per session — that navigate to the existing `/[locale]/analytics/discovery/session/{id}` detail page. Empty days remain inert plain-text cells. No new dependencies, no schema or API changes.

**Tech Stack:** Next.js 16 App Router, TypeScript, `@base-ui/react@1.3.0` (already a dep), Tailwind CSS 4, `next-intl`, `next/link`.

**Spec reference:** `docs/superpowers/specs/2026-05-13-session-calendar-multi-session-popover-design.md`

---

## File Structure

**Modify:**
- `components/discovery/SessionCalendar.tsx` — single component rewrite. Adds import for Base UI Popover, replaces the cell `<Link>` with a Popover trigger + popup, adds inline `hhmm` helper and `+N` indicator.

**Create:**
- None.

**Tests:**
- None automated (codebase has no component-test runner). Verification is a manual browser smoke test at the end of Task 2.

---

## Task 1: Add `+N` overflow indicator to current cell

This change is purely additive and preserves the existing `<Link>` interaction. It lands first so we can verify the indicator behaves correctly in isolation before the more invasive Popover swap.

**Files:**
- Modify: `components/discovery/SessionCalendar.tsx`

- [ ] **Step 1: Apply the edit**

Open `components/discovery/SessionCalendar.tsx`. Find this block (currently around lines 90–96 — the dot cluster inside the `<Link>`):

```tsx
								<div className="flex gap-0.5 mt-0.5">
									{cell.sessions.slice(0, 4).map((s) => (
										<span
											key={s.id}
											className={`w-1.5 h-1.5 rounded-full ${statusColor(s.status)} ${s.context === "live_commerce" ? "ring-1 ring-purple-400" : ""}`}
										/>
									))}
								</div>
```

Replace with:

```tsx
								<div className="flex gap-0.5 mt-0.5 items-center">
									{cell.sessions.slice(0, 4).map((s) => (
										<span
											key={s.id}
											className={`w-1.5 h-1.5 rounded-full ${statusColor(s.status)} ${s.context === "live_commerce" ? "ring-1 ring-purple-400" : ""}`}
										/>
									))}
									{cell.sessions.length > 4 && (
										<span className="text-[9px] text-gray-500 ml-0.5">
											+{cell.sessions.length - 4}
										</span>
									)}
								</div>
```

Only two semantic changes:
1. Added `items-center` to the wrapping flex so the `+N` text aligns with the dots vertically.
2. Inserted the `+{count - 4}` span after the dot map, conditionally.

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 3: Visual sanity check (optional, skip if no dev DB access)**

Start dev server:
```bash
npm run dev
```

Open `http://localhost:3000/ja/analytics/discovery/history` in a browser. Look for any day cell with 5 or more sessions. (If today is a low-activity day, this may not be visible — that's fine, the indicator is a no-op when ≤4 sessions exist.)

Expected: cells with ≥5 sessions show 4 dots followed by `+N` where N is sessions beyond the first 4.

If no qualifying day exists, this step is informational only — proceed to commit. The Popover task below will exercise the indicator more thoroughly.

- [ ] **Step 4: Commit**

```bash
git add components/discovery/SessionCalendar.tsx
git commit -m "feat(discovery): show +N overflow indicator for days with >4 sessions"
```

---

## Task 2: Replace day-cell Link with Base UI Popover

Replace the cell `<Link>` with a `Popover.Trigger` button. Opening the popover shows a vertical list of sessions; each row is its own `<Link>` to the session detail page.

**Files:**
- Modify: `components/discovery/SessionCalendar.tsx`

- [ ] **Step 1: Add the Base UI import**

At the top of `components/discovery/SessionCalendar.tsx`, find the existing imports:

```tsx
"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
```

Append two lines so the imports block becomes:

```tsx
"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Popover } from "@base-ui/react/popover";
import { Home, Tv } from "lucide-react";
```

Why `Home` / `Tv`: SessionList uses these same icons (lines 4–5 of `components/discovery/SessionList.tsx`) for context badges. Reusing the same icons keeps the popup visually consistent with the list below the calendar.

- [ ] **Step 2: Add two inline helpers above the component**

Just above the `export function SessionCalendar(...)` line, add:

```tsx
function hhmm(iso: string): string {
	return new Date(iso).toLocaleTimeString("ja-JP", {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function statusLabel(status: SessionRow["status"]): string {
	switch (status) {
		case "completed":
			return "完了";
		case "partial":
			return "部分";
		case "failed":
			return "失敗";
		default:
			return "実行中";
	}
}

function statusBadgeClasses(status: SessionRow["status"]): string {
	switch (status) {
		case "completed":
			return "bg-green-100 text-green-700";
		case "partial":
			return "bg-yellow-100 text-yellow-700";
		case "failed":
			return "bg-red-100 text-red-700";
		default:
			return "bg-blue-100 text-blue-700";
	}
}
```

These intentionally mirror `SessionList`'s `statusBadge` (lines 7–18) — keep both files visually aligned. Do NOT extract to a shared module in this task: YAGNI, and the two files have slightly different color treatments (the calendar uses solid fills via `statusColor()` for dots, while the popup rows use the lighter `bg-*-100` badge style same as the list).

- [ ] **Step 3: Replace the cell rendering**

Find this block (currently around lines 79–99 — the `if (cell.sessions.length === 0)` branch through the closing `</Link>`):

```tsx
						if (cell.sessions.length === 0) {
							return (
								<div key={i} className="aspect-square flex flex-col items-center justify-start pt-1 text-[10px] text-gray-300">
									{cell.day}
								</div>
							);
						}
						const first = cell.sessions[0];
						const href = `/${locale}/analytics/discovery/session/${first.id}`;
						return (
							<Link
								key={i}
								href={href}
								className="aspect-square flex flex-col items-center justify-start pt-1 rounded hover:bg-gray-50 transition-colors"
								title={cell.sessions.map((s) => `${s.context === "home_shopping" ? "ホーム" : "ライブ"}: ${s.status} (${s.produced_count})`).join("\n")}
							>
								<span className="text-[10px] text-gray-700">{cell.day}</span>
								<div className="flex gap-0.5 mt-0.5 items-center">
									{cell.sessions.slice(0, 4).map((s) => (
										<span
											key={s.id}
											className={`w-1.5 h-1.5 rounded-full ${statusColor(s.status)} ${s.context === "live_commerce" ? "ring-1 ring-purple-400" : ""}`}
										/>
									))}
									{cell.sessions.length > 4 && (
										<span className="text-[9px] text-gray-500 ml-0.5">
											+{cell.sessions.length - 4}
										</span>
									)}
								</div>
							</Link>
						);
```

Replace with:

```tsx
						if (cell.sessions.length === 0) {
							return (
								<div key={i} className="aspect-square flex flex-col items-center justify-start pt-1 text-[10px] text-gray-300">
									{cell.day}
								</div>
							);
						}
						return (
							<Popover.Root key={i}>
								<Popover.Trigger
									className="aspect-square flex flex-col items-center justify-start pt-1 rounded hover:bg-gray-50 transition-colors w-full"
									aria-label={`${mon + 1}月${cell.day}日 — ${cell.sessions.length} sessions`}
								>
									<span className="text-[10px] text-gray-700">{cell.day}</span>
									<div className="flex gap-0.5 mt-0.5 items-center">
										{cell.sessions.slice(0, 4).map((s) => (
											<span
												key={s.id}
												className={`w-1.5 h-1.5 rounded-full ${statusColor(s.status)} ${s.context === "live_commerce" ? "ring-1 ring-purple-400" : ""}`}
											/>
										))}
										{cell.sessions.length > 4 && (
											<span className="text-[9px] text-gray-500 ml-0.5">
												+{cell.sessions.length - 4}
											</span>
										)}
									</div>
								</Popover.Trigger>
								<Popover.Portal>
									<Popover.Positioner sideOffset={6} align="start">
										<Popover.Popup className="bg-white border border-gray-200 rounded-lg shadow-lg w-56 overflow-hidden">
											<div className="px-3 py-2 text-[11px] font-semibold text-gray-700 border-b border-gray-100 bg-gray-50">
												{year}年{mon + 1}月{cell.day}日 ({cell.sessions.length})
											</div>
											<ul className="divide-y divide-gray-100 max-h-72 overflow-auto">
												{cell.sessions.map((s) => {
													const isHome = s.context === "home_shopping";
													return (
														<li key={s.id}>
															<Link
																href={`/${locale}/analytics/discovery/session/${s.id}`}
																className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-50"
															>
																<span className="font-mono text-[11px] text-gray-500 w-10 shrink-0">
																	{hhmm(s.run_at)}
																</span>
																<span
																	className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
																		isHome
																			? "bg-blue-50 text-blue-700 border border-blue-200"
																			: "bg-purple-50 text-purple-700 border border-purple-200"
																	}`}
																>
																	{isHome ? <Home size={9} /> : <Tv size={9} />}
																	{isHome ? "ホーム" : "ライブ"}
																</span>
																<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusBadgeClasses(s.status)}`}>
																	{statusLabel(s.status)}
																</span>
																<span className="ml-auto text-[11px] text-gray-600 shrink-0">
																	{s.produced_count}件
																</span>
															</Link>
														</li>
													);
												})}
											</ul>
										</Popover.Popup>
									</Popover.Positioner>
								</Popover.Portal>
							</Popover.Root>
						);
```

Key changes:
1. The cell is now a `Popover.Trigger` button (Base UI renders it as `<button>` by default), not a `<Link>`. Its `aria-label` conveys date and session count to screen readers; the `title` tooltip is no longer needed and is removed (the popup itself carries the same information in a more usable form).
2. The popup is a portaled `<Popover.Popup>` with a header (year/month/day + count), a scrollable `<ul>` (`max-h-72 overflow-auto` for days with many sessions), and one `<Link>` per session. Each row mirrors the SessionList layout: time → context badge → status badge → count.
3. `+N` indicator stays exactly as introduced in Task 1.

- [ ] **Step 4: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 5: Verify lint passes (best-effort)**

Run:
```bash
npm run lint
```

Expected: clean run. ESLint may flag the inline `<Link>` inside the `<li>` — that's standard Next.js usage and should pass; if it doesn't, address the specific complaint without restructuring the JSX.

- [ ] **Step 6: Commit**

```bash
git add components/discovery/SessionCalendar.tsx
git commit -m "feat(discovery): SessionCalendar opens a popover listing all sessions per day"
```

---

## Task 3: Manual browser smoke test

No code changes. Walk through the spec §11 verification checklist against the dev server. Document any issues found as follow-ups; do NOT silently fix them — surface them and let the reviewer decide.

**Files:** None (verification only).

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Open `http://localhost:3000/ja/analytics/discovery/history`.

- [ ] **Step 2: Run the checklist**

For each item below, observe the behavior and write a one-line PASS/FAIL note. If a case is not reproducible because no qualifying day exists in the visible month, mark it `N/A — no qualifying day visible`. Use the month navigation arrows in the UI to scroll back to months with more data.

Checklist:
- [ ] **Empty day** — pick a day with no sessions. Confirm: gray day number, no hover effect, no trigger.
- [ ] **1-session day** — pick a day with exactly one session (look for a single dot). Click the cell. Confirm: popover opens, one row visible, click row → navigates to `/{locale}/analytics/discovery/session/{id}`, focus returns sensibly.
- [ ] **4-session day** — pick a day with exactly 4 dots and no `+N`. Click the cell. Confirm: popover opens, 4 rows visible, no `+N` indicator, no scrollbar inside the popup.
- [ ] **>4 sessions** — pick a day with 4 dots + `+N`. Click the cell. Confirm: popover opens, all sessions listed (not just 4), scrollbar appears if list exceeds `max-h-72` (≈ 18rem), all rows clickable.
- [ ] **Keyboard navigation** — Tab to a populated cell trigger. Press Enter — popover opens, focus moves into the popup. Tab through rows. Press Enter on a row — navigates. Press ESC instead of Enter — popover closes, focus returns to the trigger.
- [ ] **Outside-click close** — Open a popover, click outside it (e.g. on the day-of-week header). Confirm: popover closes.
- [ ] **Viewport overflow** — Open a popover on a day cell in the right-most column of the calendar. Confirm: Base UI's auto-flip kicks in, popup stays within the viewport horizontally. If it overflows, file as a follow-up (not a blocker).
- [ ] **Month navigation** — Click the `→` arrow to advance a month. Confirm: cells re-render correctly, any open popover closes when the month changes.
- [ ] **Context filter** — Click the `ホーム` / `ライブ` filter buttons. Confirm: cells update; the popup, if reopened, reflects the filtered set.
- [ ] **Console warnings** — Open browser devtools. Confirm: no React warnings about keys, missing aria, or hydration mismatch.

- [ ] **Step 3: Stop the dev server**

Ctrl-C the running `npm run dev`.

- [ ] **Step 4: Report findings**

If any checklist item failed, document the failure in the implementer's report (status `DONE_WITH_CONCERNS` if functional but rough, `BLOCKED` if a row is unreachable). Do NOT make code changes from the smoke test in this task — let the reviewer decide whether to patch in a follow-up commit.

No commit in this task.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Component changes (Popover swap) | Task 2 |
| §2 Status dot and badge helpers | Task 2 (inline `statusLabel` + `statusBadgeClasses`) |
| §3 Time formatting (`hhmm`) | Task 2 |
| §4 Data and types (no change) | n/a — confirmed in Task 2 (no SessionRow modification) |
| §5 Accessibility (aria-label, ESC, focus) | Task 2 trigger + Task 3 verification |
| §6 Uniform behavior for 1-session days | Task 2 (no conditional branch added) |
| §7 `+N` indicator | Task 1 |
| §8 Empty popup edge case | Task 2 (if-empty-then-plain-div branch retained) |
| §9 Popup positioning (`sideOffset`, `align`) | Task 2 |
| §10 Performance (no memoization) | n/a — no work needed |
| §11 Manual verification checklist | Task 3 |
| §12 Migration / rollback | n/a — single-file revert |

All sections covered.

**2. Placeholder scan:**

- No "TBD", "implement later", or "similar to Task N" patterns.
- Task 3 contains an explicit checklist (rather than vague "verify it works") — each item names a concrete pass condition.
- Code blocks are complete; the implementer can paste the Task 2 Step 3 replacement verbatim.

**3. Type consistency:**

- `SessionRow["status"]` is consistently referenced in `statusColor` (existing), `statusLabel` (Task 2), `statusBadgeClasses` (Task 2). Same union, no drift.
- `hhmm(s.run_at)` is called where `s.run_at` is `string` per `SessionRow` — matches.
- Base UI Popover parts (`Root`, `Trigger`, `Portal`, `Positioner`, `Popup`) match the verified exports in `@base-ui/react@1.3.0/popover`.

No issues found.

---

## Out of scope (deferred to future plans)

- Searching/filtering inside the popup (e.g., "show only failed today").
- Applying the same popover pattern to the `/[locale]/broadcasts` calendar — different interaction model (cell click filters a separate panel rather than navigating).
- Extracting `statusLabel` / `statusBadgeClasses` into a shared `components/discovery/sessionStatus.ts` — wait for a third consumer before DRYing.
- Automated component tests — codebase has no test runner for React components; introducing one is its own project.
