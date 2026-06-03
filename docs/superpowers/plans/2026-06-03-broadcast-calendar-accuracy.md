# Broadcast Calendar Accuracy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the broadcast calendar's displayed slots match what actually airs — show un-classified QVC slots, show today/upcoming ShopCh, drop stale forward slots, and fix the JST "today" highlight.

**Architecture:** Four independent fixes. (A) Extract the whitelist gate to a pure module and make it fail-open on null category. (B) New ShopCh forward-scrape helper wired into the JST 02:00 refresh cron. (C) New future-only reconciliation helper that deletes vanished forward slots, called from both forward-refresh paths. (D) A JST-today helper used by `MonthGrid`. Runtime is assumed UTC (Vercel), matching all existing date code.

**Tech Stack:** TypeScript, Next.js (App Router, client + server), Supabase (supabase-js), cheerio scrapers, `tsx` + `node:assert` smoke tests.

**Spec:** `docs/superpowers/specs/2026-06-02-broadcast-calendar-accuracy-design.md`

---

## File Structure

- `lib/broadcasts/jst-date.ts` — **modify**: add `getTodayISOJST()`.
- `components/broadcasts/MonthGrid.tsx` — **modify** (line 71): use `getTodayISOJST()`.
- `lib/broadcasts/whitelist-gate.ts` — **create**: pure `CATEGORIES_BY_CHANNEL`, whitelist sets, fail-open `isWhitelistedSlot()`. Extracted from the panel so it is testable without React.
- `components/broadcasts/UnifiedDayDetailPanel.tsx` — **modify**: import the gate from the new module; delete the in-file copies.
- `lib/broadcasts/reconcile.ts` — **create**: `shouldReconcileDate()` (pure guard) + `reconcileFutureSlots()` (future-only delete).
- `lib/broadcasts/qvc-monthly.ts` — **modify** (`refreshQVCMonthlyRange`): reconcile future dates after a successful non-empty scrape.
- `lib/broadcasts/shopch-forward.ts` — **create**: `getForwardDates()` + `refreshShopChForwardRange()`.
- `app/api/cron/qvc-monthly-refresh/route.ts` — **modify**: also run `refreshShopChForwardRange`.
- `scripts/diag-calendar-accuracy.ts` — **keep** (promote to npm script); `scripts/diag-shopch-forward.ts` — **delete**.
- `package.json` — **modify**: add `verify:calendar-accuracy`, `test:calendar-accuracy`, `test:shopch-forward`.
- `scripts/test-calendar-accuracy.ts` — **create**: unit assertions for A, C-guard, D.
- `scripts/test-shopch-forward.ts` — **create**: live integration for B.
- `CLAUDE.md` — **modify**: update the whitelist policy paragraph to record fail-open semantics.

---

## Task 1: JST-today helper + MonthGrid fix (D)

**Files:**
- Create: `scripts/test-calendar-accuracy.ts`
- Modify: `lib/broadcasts/jst-date.ts`
- Modify: `components/broadcasts/MonthGrid.tsx:71`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-calendar-accuracy.ts`:

```ts
/**
 * Unit assertions for broadcast-calendar accuracy fixes (A, C-guard, D).
 * Pure logic only — no DB. Run: npm run test:calendar-accuracy
 */
import assert from "node:assert";
import { getTodayISOJST } from "../lib/broadcasts/jst-date";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

// --- D: getTodayISOJST ---
// 2026-06-02T18:30:00Z is 2026-06-03 03:30 JST → JST date is 2026-06-03.
check(
	"getTodayISOJST rolls to JST day during JST early morning",
	getTodayISOJST(new Date("2026-06-02T18:30:00Z")) === "2026-06-03",
);
// 2026-06-02T02:00:00Z is 2026-06-02 11:00 JST → 2026-06-02.
check(
	"getTodayISOJST same day midday",
	getTodayISOJST(new Date("2026-06-02T02:00:00Z")) === "2026-06-02",
);

console.log(`[test:calendar-accuracy] ${passed} assertions passed`);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, after `"verify:broadcasts"`, add:

```json
    "test:calendar-accuracy": "tsx scripts/test-calendar-accuracy.ts",
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:calendar-accuracy`
Expected: FAIL — `getTodayISOJST` is not exported (import error).

- [ ] **Step 4: Implement `getTodayISOJST`**

In `lib/broadcasts/jst-date.ts`, after `getYesterdayJST` (after line 20), add:

```ts
/**
 * Returns "YYYY-MM-DD" for "today in JST". Works on both server and client:
 * Date.now() is a UTC epoch, so shifting by +9h and reading the ISO date gives
 * the JST calendar day regardless of the host's local timezone.
 */
export function getTodayISOJST(nowUtc: Date = new Date()): string {
	return new Date(nowUtc.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:calendar-accuracy`
Expected: PASS — `[test:calendar-accuracy] 2 assertions passed`

- [ ] **Step 6: Fix MonthGrid**

In `components/broadcasts/MonthGrid.tsx`, add the import at the top (with the other imports):

```ts
import { getTodayISOJST } from "@/lib/broadcasts/jst-date";
```

Replace line 71:

```ts
	const todayIso = new Date().toISOString().slice(0, 10);
```

with:

```ts
	const todayIso = getTodayISOJST();
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add lib/broadcasts/jst-date.ts components/broadcasts/MonthGrid.tsx scripts/test-calendar-accuracy.ts package.json
git commit -m "fix(broadcasts): MonthGrid today highlight uses JST not UTC"
```

---

## Task 2: Fail-open whitelist gate (A)

**Files:**
- Create: `lib/broadcasts/whitelist-gate.ts`
- Modify: `components/broadcasts/UnifiedDayDetailPanel.tsx`
- Modify: `scripts/test-calendar-accuracy.ts`

- [ ] **Step 1: Add failing tests for the gate**

In `scripts/test-calendar-accuracy.ts`, add the import at the top (after the existing import):

```ts
import { isWhitelistedSlot } from "../lib/broadcasts/whitelist-gate";
```

And add assertions before the final `console.log`:

```ts
// --- A: fail-open whitelist gate ---
check("qvc null category shown (fail-open)", isWhitelistedSlot("qvc", null) === true);
check("qvc empty category shown (fail-open)", isWhitelistedSlot("qvc", "") === true);
check("qvc whitelisted category shown", isWhitelistedSlot("qvc", "家電") === true);
check("qvc known non-whitelist hidden", isWhitelistedSlot("qvc", "占い") === false);
check("shopch null category shown (fail-open)", isWhitelistedSlot("shopch", null) === true);
check("shopch whitelisted shown", isWhitelistedSlot("shopch", "コスメ") === true);
check("shopch known non-whitelist hidden", isWhitelistedSlot("shopch", "雑貨") === false);
check("oa channel always shown", isWhitelistedSlot("ntv", null) === true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:calendar-accuracy`
Expected: FAIL — `whitelist-gate` module not found.

- [ ] **Step 3: Create the gate module**

Create `lib/broadcasts/whitelist-gate.ts` (move the constants + sets + gate out of the panel — pure, no React):

```ts
/**
 * Display-time category whitelist gate for QVC / ShopCh calendar slots.
 * Extracted from UnifiedDayDetailPanel so it is unit-testable without React.
 *
 * Policy (2026-06-03, fail-open): a slot with NO category (null / "") is
 * UNCLASSIFIED, not non-whitelist — show it. Only hide a QVC/ShopCh slot whose
 * category is KNOWN and not on the whitelist. OA channels have no whitelist.
 * See CLAUDE.md "Broadcast Calendar".
 */
export const CATEGORIES_BY_CHANNEL: Record<"qvc" | "shopch", readonly string[]> = {
	qvc: [
		"ビューティ",
		"ファッション",
		"健康・ダイエット",
		"ホーム・キッチン",
		"レジャー・ホビー",
		"家電",
	],
	shopch: [
		"コスメ",
		"グルメ・お酒",
		"美容・ダイエット・フィットネス",
		"靴・バッグ・小物・インナー",
		"ファッション",
		"ミックス",
		"ホーム・インテリア",
		"家電",
		"ジュエリー",
		"旅・趣味・暮らし・コレクターズ",
	],
};

const QVC_WHITELIST = new Set<string>(CATEGORIES_BY_CHANNEL.qvc);
const SHOPCH_WHITELIST = new Set<string>(CATEGORIES_BY_CHANNEL.shopch);

/**
 * Fail-open: unclassified (null/empty) QVC/ShopCh slots are shown; only a
 * known-and-non-whitelist category is hidden. Non-QVC/ShopCh channels pass.
 */
export function isWhitelistedSlot(channel: string, category: string | null): boolean {
	if (channel === "qvc") return !category || QVC_WHITELIST.has(category);
	if (channel === "shopch") return !category || SHOPCH_WHITELIST.has(category);
	return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:calendar-accuracy`
Expected: PASS — `[test:calendar-accuracy] 10 assertions passed`

- [ ] **Step 5: Rewire the panel to use the module**

In `components/broadcasts/UnifiedDayDetailPanel.tsx`:

(a) Add the import near the top (with the other `@/lib/broadcasts` imports):

```ts
import { CATEGORIES_BY_CHANNEL, isWhitelistedSlot } from "@/lib/broadcasts/whitelist-gate";
```

(b) DELETE the in-file `CATEGORIES_BY_CHANNEL` const (lines 16-48), the `QVC_WHITELIST` / `SHOPCH_WHITELIST` consts (lines 50-51), and the in-file `isWhitelistedSlot` function (lines 53-61). The imported versions replace them. Leave every other reference (`matchesFilters`, `channelCount`, `visibleCategories`) unchanged — they already call `isWhitelistedSlot` / `CATEGORIES_BY_CHANNEL` by the same names.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (If it reports `CATEGORIES_BY_CHANNEL`/`isWhitelistedSlot` redeclared, the in-file copies were not fully deleted — remove them.)

- [ ] **Step 7: Commit**

```bash
git add lib/broadcasts/whitelist-gate.ts components/broadcasts/UnifiedDayDetailPanel.tsx scripts/test-calendar-accuracy.ts
git commit -m "fix(broadcasts): fail-open whitelist gate shows unclassified slots"
```

---

## Task 3: Future-only reconciliation helper (C)

**Files:**
- Create: `lib/broadcasts/reconcile.ts`
- Modify: `lib/broadcasts/qvc-monthly.ts`
- Modify: `scripts/test-calendar-accuracy.ts`

- [ ] **Step 1: Add failing tests for the guard**

In `scripts/test-calendar-accuracy.ts`, add the import:

```ts
import { shouldReconcileDate } from "../lib/broadcasts/reconcile";
```

And assertions before the final `console.log`:

```ts
// --- C: reconciliation guard (future-only, non-empty scrape) ---
check("reconcile future date with slots", shouldReconcileDate("2026-06-10", "2026-06-03", 20) === true);
check("reconcile NOT today", shouldReconcileDate("2026-06-03", "2026-06-03", 20) === false);
check("reconcile NOT past", shouldReconcileDate("2026-05-30", "2026-06-03", 20) === false);
check("reconcile NOT on empty scrape", shouldReconcileDate("2026-06-10", "2026-06-03", 0) === false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:calendar-accuracy`
Expected: FAIL — `reconcile` module / `shouldReconcileDate` not found.

- [ ] **Step 3: Create the reconcile module**

Create `lib/broadcasts/reconcile.ts`:

```ts
import { getServiceClient } from "@/lib/supabase";

/**
 * True when a (channel, isoDate) scrape result may delete vanished slots.
 * Strictly future only (never today/past), and only when the fresh scrape
 * actually returned slots (never reconcile against an empty/failed scrape —
 * that would wipe a whole day on a transient upstream error).
 */
export function shouldReconcileDate(
	isoDate: string,
	todayIso: string,
	scrapedSlotCount: number,
): boolean {
	return isoDate > todayIso && scrapedSlotCount > 0;
}

/**
 * Delete broadcasts rows for a strictly-future (channel, isoDate) that are NOT
 * in the freshly-scraped start_time set — i.e. slots QVC/ShopCh rescheduled or
 * cancelled after publishing them ahead of time.
 *
 * Footgun guards (see CLAUDE.md daily:archive footgun):
 *  - caller must gate on shouldReconcileDate (future-only, non-empty);
 *  - archived_video_s3 IS NULL and video_status NOT IN downloading/archived,
 *    so an archived recording can never be deleted (future slots have none, but
 *    this is belt-and-suspenders).
 * Returns the number of rows deleted.
 */
export async function reconcileFutureSlots(
	channel: string,
	isoDate: string,
	keepStartTimes: string[],
): Promise<number> {
	if (keepStartTimes.length === 0) return 0;
	const sb = getServiceClient();
	const keepList = `(${keepStartTimes.map((t) => `"${t}"`).join(",")})`;

	const { data, error } = await sb
		.from("broadcasts")
		.delete()
		.eq("channel", channel)
		.eq("air_date", isoDate)
		.is("archived_video_s3", null)
		.not("video_status", "in", '("downloading","archived")')
		.not("start_time", "in", keepList)
		.select("id");

	if (error) {
		console.warn(`[reconcile] ${channel} ${isoDate} delete failed: ${error.message}`);
		return 0;
	}
	return (data ?? []).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:calendar-accuracy`
Expected: PASS — `[test:calendar-accuracy] 14 assertions passed`

- [ ] **Step 5: Wire reconciliation into the QVC monthly refresh**

In `lib/broadcasts/qvc-monthly.ts`:

(a) Add the import after line 14:

```ts
import { shouldReconcileDate, reconcileFutureSlots } from "./reconcile";
```

(b) In `MonthlyRefreshSummary` (interface, ~line 42), add a field:

```ts
	reconciledDeleted: number;
```

(c) In `refreshQVCMonthlyRange`, after `let updated = 0;` (line 65) add:

```ts
	let reconciledDeleted = 0;
	const todayIso = `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}-${pad2(today.getUTCDate())}`;
```

(d) Inside the loop, after the `inserted += persist.inserted; updated += persist.updated;` block and before the `if (persist.errors.length > 0)` block (around line 82), add:

```ts
				if (shouldReconcileDate(iso, todayIso, result.slots.length)) {
					reconciledDeleted += await reconcileFutureSlots(
						"qvc",
						iso,
						result.slots.map((s) => s.start_time),
					);
				}
```

(e) Add `reconciledDeleted` to the returned object (line 99-107):

```ts
	return {
		dates: dates.length,
		succeeded,
		failed,
		totalSlots,
		inserted,
		updated,
		reconciledDeleted,
		errors,
	};
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add lib/broadcasts/reconcile.ts lib/broadcasts/qvc-monthly.ts scripts/test-calendar-accuracy.ts
git commit -m "fix(broadcasts): future-only reconciliation drops vanished QVC forward slots"
```

---

## Task 4: ShopCh forward scrape (B) + reconciliation + cron wiring

**Files:**
- Create: `lib/broadcasts/shopch-forward.ts`
- Create: `scripts/test-shopch-forward.ts`
- Modify: `app/api/cron/qvc-monthly-refresh/route.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the forward-scrape helper**

Create `lib/broadcasts/shopch-forward.ts`:

```ts
/**
 * ShopCh forward refresh. The daily cron only scrapes "yesterday", so today and
 * upcoming ShopCh slots never appear on the calendar. shopch.jp's programlist
 * DOES serve future-day program IDs (verified 2026-06-02: each onAirDay request
 * returns that day's IDs, ~24-26/day), so we re-use scrapeShopChannelForDate
 * per forward date. Slots arrive with category populated from JSON pgmcategory,
 * so the whitelist gate works without extra enrichment. Video archival is NOT
 * needed forward — it runs only on air_date <= today via the daily flow.
 *
 * Runtime is assumed UTC (Vercel), matching scrapeShopChannelForDate's date
 * handling and the rest of the broadcast crons.
 */
import { scrapeShopChannelForDate } from "./shopch";
import { upsertBroadcasts } from "./persist";
import { shouldReconcileDate, reconcileFutureSlots } from "./reconcile";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function isoOf(date: Date): string {
	return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * JST-today .. JST-today+daysAhead as UTC-midnight Dates (inclusive of today).
 * `todayJst` is a Date whose UTC y/m/d are the JST calendar day (as produced by
 * `new Date(Date.now() + 9*3600*1000)`).
 */
export function getForwardDates(todayJst: Date, daysAhead: number): Date[] {
	const y = todayJst.getUTCFullYear();
	const m = todayJst.getUTCMonth();
	const d = todayJst.getUTCDate();
	const dates: Date[] = [];
	for (let i = 0; i <= daysAhead; i++) {
		dates.push(new Date(Date.UTC(y, m, d + i)));
	}
	return dates;
}

export interface ShopChForwardSummary {
	dates: number;
	succeeded: number;
	failed: number;
	totalSlots: number;
	inserted: number;
	updated: number;
	reconciledDeleted: number;
	errors: Array<{ date: string; error: string }>;
}

export async function refreshShopChForwardRange(
	daysAhead = Number(process.env.SHOPCH_FORWARD_DAYS ?? 14),
	todayJst: Date = new Date(Date.now() + 9 * 3600 * 1000),
): Promise<ShopChForwardSummary> {
	const dates = getForwardDates(todayJst, daysAhead);
	const todayIso = isoOf(todayJst);
	let succeeded = 0;
	let failed = 0;
	let totalSlots = 0;
	let inserted = 0;
	let updated = 0;
	let reconciledDeleted = 0;
	const errors: Array<{ date: string; error: string }> = [];

	for (const date of dates) {
		const iso = isoOf(date);
		try {
			const result = await scrapeShopChannelForDate(date);
			if (!result.ok) {
				failed += 1;
				errors.push({ date: iso, error: result.error ?? "unknown" });
				continue;
			}
			succeeded += 1;
			if (result.slots.length > 0) {
				const persist = await upsertBroadcasts(result.slots);
				totalSlots += result.slots.length;
				inserted += persist.inserted;
				updated += persist.updated;
				if (shouldReconcileDate(iso, todayIso, result.slots.length)) {
					reconciledDeleted += await reconcileFutureSlots(
						"shopch",
						iso,
						result.slots.map((s) => s.start_time),
					);
				}
				if (persist.errors.length > 0) {
					errors.push({ date: iso, error: `persist: ${persist.errors[0].error}` });
				}
			}
		} catch (e) {
			failed += 1;
			errors.push({ date: iso, error: e instanceof Error ? e.message : String(e) });
		}
	}

	return { dates: dates.length, succeeded, failed, totalSlots, inserted, updated, reconciledDeleted, errors };
}
```

- [ ] **Step 2: Create the live integration test**

Create `scripts/test-shopch-forward.ts`:

```ts
/**
 * Live integration: ShopCh forward scrape returns today + future slots.
 * Tolerates the busy page (rate-limit) as a skip, not a failure.
 * Run: npm run test:shopch-forward
 */
import assert from "node:assert";
import { refreshShopChForwardRange } from "../lib/broadcasts/shopch-forward";

async function main() {
	// today + 2 days
	const summary = await refreshShopChForwardRange(2);
	console.log("[test:shopch-forward] summary:", JSON.stringify(summary));

	const busyOnly =
		summary.succeeded === 0 &&
		summary.errors.every((e) => /busy|集中|rate/i.test(e.error));
	if (busyOnly) {
		console.log("[test:shopch-forward] SKIPPED — shopch busy page (rate limited)");
		return;
	}

	assert.ok(summary.succeeded > 0, "at least one date scraped ok");
	assert.ok(summary.totalSlots > 0, "at least one ShopCh slot found across today..+2");
	console.log("[test:shopch-forward] PASS");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
```

- [ ] **Step 3: Add the npm scripts**

In `package.json`, after `"test:calendar-accuracy"`, add:

```json
    "test:shopch-forward": "tsx --env-file=.env.local scripts/test-shopch-forward.ts",
```

- [ ] **Step 4: Run the live test**

Run: `npm run test:shopch-forward`
Expected: PASS (`totalSlots > 0`) — or SKIPPED if shopch.jp returns the busy page. If it FAILS with a parse/contract error, STOP and report (upstream markup may have changed).

- [ ] **Step 5: Wire into the JST 02:00 refresh cron**

In `app/api/cron/qvc-monthly-refresh/route.ts`:

(a) Add the import after line 5:

```ts
import { refreshShopChForwardRange } from "@/lib/broadcasts/shopch-forward";
```

(b) After the QVC `const summary = await refreshQVCMonthlyRange(jstNow());` (line 31), add:

```ts
	// ShopCh has no programme-guide month endpoint, but its programlist serves
	// future-day program IDs — pull today..+SHOPCH_FORWARD_DAYS so the calendar
	// shows upcoming ShopCh slots (the daily cron only scrapes yesterday).
	let shopchForward: Awaited<ReturnType<typeof refreshShopChForwardRange>> | { error: string };
	try {
		shopchForward = await refreshShopChForwardRange();
	} catch (err) {
		shopchForward = { error: err instanceof Error ? err.message : String(err) };
		console.warn("[qvc-monthly-refresh] refreshShopChForwardRange failed", shopchForward);
	}
```

(c) Add `shopchForward` to the `log` object (after `...summary,` on line 50):

```ts
		shopchForward,
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add lib/broadcasts/shopch-forward.ts scripts/test-shopch-forward.ts app/api/cron/qvc-monthly-refresh/route.ts package.json
git commit -m "feat(broadcasts): ShopCh forward scrape wired into JST 02:00 refresh"
```

---

## Task 5: Diagnostics + docs

**Files:**
- Delete: `scripts/diag-shopch-forward.ts`
- Modify: `package.json`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Promote the calendar diagnostic to a verify script**

In `package.json`, after `"verify:broadcasts"`, add:

```json
    "verify:calendar-accuracy": "tsx --env-file=.env.local scripts/diag-calendar-accuracy.ts",
```

- [ ] **Step 2: Delete the one-shot probe**

The ShopCh forward question is answered and captured in the spec; the probe is no longer needed.

```bash
git rm scripts/diag-shopch-forward.ts
```

- [ ] **Step 3: Update the CLAUDE.md whitelist policy note**

In `CLAUDE.md`, find the bullet beginning "Category whitelist (Phase 1-C ...". In the sentence describing the policy, append a dated fail-open note. After the existing "Policy (2026-05-18 v3): ..." sentence, add:

```
**Update (2026-06-03, fail-open): a slot with NO category (null/unclassified) is now SHOWN — only a KNOWN non-whitelist category is hidden. Forward QVC slots arrive un-enriched (category null) and must not be hidden as if non-whitelist. The gate lives in `lib/broadcasts/whitelist-gate.ts` (extracted from UnifiedDayDetailPanel).**
```

Also find the bullet describing the QVC monthly refresh / ShopCh and append:

```
ShopCh forward slots (today..+`SHOPCH_FORWARD_DAYS`, default 14) are scraped by `lib/broadcasts/shopch-forward.ts::refreshShopChForwardRange`, wired into the JST 02:00 `qvc-monthly-refresh` cron. Both forward paths run future-only reconciliation (`lib/broadcasts/reconcile.ts`) that deletes rescheduled/cancelled forward slots — strictly `air_date > today_jst`, never touching archived rows.
```

- [ ] **Step 4: Commit**

```bash
git add package.json CLAUDE.md
git commit -m "docs: calendar-accuracy verify script + fail-open/forward policy notes"
```

---

## Task 6: Full verification

- [ ] **Step 1: Unit tests**

Run: `npm run test:calendar-accuracy`
Expected: PASS — `[test:calendar-accuracy] 14 assertions passed`

- [ ] **Step 2: Live ShopCh forward**

Run: `npm run test:shopch-forward`
Expected: PASS or SKIPPED (busy page). Not FAIL.

- [ ] **Step 3: Live calendar diagnostic (before/after sanity)**

Run: `npm run verify:calendar-accuracy`
Expected: today/future QVC dates should now report far fewer (ideally ~0) "hidden" once the panel change is deployed; ShopCh today/future should show non-zero `total` after the forward refresh has run at least once. (The diagnostic reads the DB directly; the fail-open gate is a UI change, so the "hidden" column reflects null-category counts — confirm those slots are no longer hidden in the actual UI.)

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: no new errors in touched files.

---

## Self-Review

**Spec coverage:**
- §3.1 Fix A fail-open gate → Task 2 (extracted to `whitelist-gate.ts`, `!category` shows null/empty; `channelCount` uses the same imported fn). ✅
- §3.2 Fix B ShopCh forward scrape + cron wiring → Task 4. ✅
- §3.3 Fix C future-only reconciliation, footgun guards (future-only + archived guard + non-empty-scrape) → Task 3 (`shouldReconcileDate` + `reconcileFutureSlots`), used by QVC (Task 3) and ShopCh (Task 4). ✅
- §3.4 Fix D MonthGrid JST → Task 1. ✅
- §4 tests: A unit (Task 2), B live (Task 4), C guard unit (Task 3), D unit (Task 1); diag promotion + probe deletion (Task 5). ✅ (Note: §4 also describes a reconciliation *integration* test with a stubbed scrape; that requires live-DB row setup. Captured as the live `verify:calendar-accuracy` sanity in Task 6 Step 3 — the pure guard is unit-tested; the delete query is exercised in production behind the future-only + archived guards. If a stronger integration test is wanted, it is follow-up.)
- §1 "videos stored in cloud?" — answered in the spec (yes); no code change. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✅

**Type consistency:** `getTodayISOJST(nowUtc?): string`, `isWhitelistedSlot(channel, category: string|null): boolean`, `shouldReconcileDate(isoDate, todayIso, count): boolean`, `reconcileFutureSlots(channel, isoDate, keepStartTimes: string[]): Promise<number>`, `refreshShopChForwardRange(daysAhead?, todayJst?): Promise<ShopChForwardSummary>`, `getForwardDates(todayJst, daysAhead): Date[]` — used consistently across tasks. `MonthlyRefreshSummary` gains `reconciledDeleted` (Task 3); the cron log already spreads `...summary`, so it surfaces automatically. ✅

**Decomposition note:** `whitelist-gate.ts` and `reconcile.ts` are small, single-responsibility, framework-free modules — testable in isolation. The panel shrinks (removes ~45 lines of constants/logic). No file grows unduly.

**Runtime assumption:** All new date code assumes a UTC host (Vercel), consistent with `getYesterdayJST`, `getMonthlyRefreshDates`, and `shopch.ts`/`qvc.ts` date formatting. Documented in `shopch-forward.ts`.
