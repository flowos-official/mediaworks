# /broadcasts 페이지 캐싱 PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/broadcasts` 페이지의 사용자 접속당 Supabase read를 (cache hit 시) 0회로 줄인다. Next.js 16의 `'use cache'` 디렉티브와 `revalidateTag` cron 무효화 패턴을 도입한다.

**Architecture:** RSC 페이지가 직접 두드리는 13개 Supabase 호출을 두 개의 `'use cache'` 헬퍼(`getCachedCalendarCounts`, `getCachedChannelTotals`)로 옮긴다. 3개의 daily cron 종료 시 `revalidateTag`로 무효화. `cacheLife({ revalidate: 6h, expire: 24h })` 안전망.

**Tech Stack:** Next.js 16.1.6 Cache Components, React 19.2.3, Supabase service-role client (`getServiceClient`), next/cache `revalidateTag`.

**Spec:** `docs/superpowers/specs/2026-05-24-broadcasts-page-caching-design.md`

**Note on tests:** Per spec, **no automated tests are added in this PoC**. `'use cache'` correctness is verified via `npm run build` (static analysis) + post-deploy manual verification. Each task ends with build verification.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/broadcasts/jst-date.ts` | Create | JST date helpers shared across 3 cron routes |
| `lib/broadcasts/cached.ts` | Create | Two `'use cache'` helpers: calendar counts + channel totals |
| `lib/broadcasts/aggregate-counts.ts` | Modify | Remove `SupabaseClient` arg; use service client internally |
| `app/[locale]/(market)/broadcasts/page.tsx` | Modify | Call cached helpers; remove inline count queries |
| `app/api/broadcasts/calendar-counts/route.ts` | Modify | Call `aggregateCalendarCounts` with new signature |
| `app/api/cron/daily-broadcasts/route.ts` | Modify | Add `revalidateTag` at end; replace local `getYesterdayJST` with shared helper |
| `app/api/cron/qvc-monthly-refresh/route.ts` | Modify | Add `revalidateTag` for previous + current month at end |
| `app/api/cron/daily-historical-broadcasts/route.ts` | Modify | Add `revalidateTag` inside try block before return |

---

## Task 1: Create JST date helpers

**Files:**
- Create: `lib/broadcasts/jst-date.ts`

- [ ] **Step 1: Create the helper module**

Path: `lib/broadcasts/jst-date.ts`

```ts
/**
 * Shared JST date helpers used by broadcast scraping crons and by the cache
 * invalidation logic that follows. Centralised here so that
 * `daily-broadcasts/route.ts` and `qvc-monthly-refresh/route.ts` stop
 * defining the same logic locally.
 */

/**
 * Returns midnight UTC for "yesterday in JST". The returned Date's
 * UTC y/m/d components match the JST calendar day immediately before
 * the JST day of `nowUtc` (or `new Date()` if omitted).
 */
export function getYesterdayJST(nowUtc: Date = new Date()): Date {
	const jstMs = nowUtc.getTime() + 9 * 3600 * 1000;
	const jstNow = new Date(jstMs);
	jstNow.setUTCDate(jstNow.getUTCDate() - 1);
	return new Date(
		Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()),
	);
}

/** Returns "YYYY-MM" for the given Date's UTC year/month. */
export function getJSTYearMonth(d: Date): string {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	return `${y}-${m}`;
}
```

- [ ] **Step 2: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/broadcasts/jst-date.ts
git commit -m "$(cat <<'EOF'
feat(broadcasts): add shared JST date helpers for cron + cache invalidation

Extracted in preparation for /broadcasts page-level caching: 3 cron routes
need consistent yesterday-JST and YYYY-MM derivation when calling
revalidateTag, and daily-broadcasts/route.ts already had a local copy of
this logic that will now be replaced.
EOF
)"
```

---

## Task 2: Refactor `aggregateCalendarCounts` signature

**Files:**
- Modify: `lib/broadcasts/aggregate-counts.ts`
- Modify: `app/[locale]/(market)/broadcasts/page.tsx` (call site)
- Modify: `app/api/broadcasts/calendar-counts/route.ts` (call site)

**Rationale:** The function currently takes a `SupabaseClient` argument. To wrap it with `'use cache'` (Task 3), all arguments must be serialisable — non-primitive clients cannot be cache keys. Move client instantiation inside the function (service-role). Both existing callers are auth-gated to `["member","admin"]` and both roles see the same broadcasts data, so RLS-bypass is behaviour-equivalent.

- [ ] **Step 1: Update `lib/broadcasts/aggregate-counts.ts`**

Replace the whole file with:

```ts
import { getServiceClient } from "@/lib/supabase";

const CHUNK_SIZE = 1000;
// Safety stop in case the table grows unexpectedly. 45-day SSR window with
// 12 channels at ~100 events/day per channel is ~54k rows worst case.
const MAX_CHUNKS = 200;

export type CountsByDate = Record<string, Record<string, number>>;

/**
 * Aggregate per-day per-channel broadcast counts across both `broadcasts`
 * (qvc + shopch) and `historical_broadcasts` (10 OA channels). Paginates
 * to bypass the PostgREST row cap that silently truncated wider date
 * windows (May 21 2026 incident: ntv dropped because rows landed past
 * the 10k cap of a single `.range()` call).
 *
 * Uses the service-role client internally. Callers must gate access at
 * their own layer (page-level `requireUser`).
 */
export async function aggregateCalendarCounts(
	from: string,
	to: string,
): Promise<CountsByDate> {
	const sb = getServiceClient();
	const counts: CountsByDate = {};

	const drainTable = async (table: "broadcasts" | "historical_broadcasts") => {
		for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
			const offset = chunk * CHUNK_SIZE;
			const { data, error } = await sb
				.from(table)
				.select("channel,air_date")
				.gte("air_date", from)
				.lte("air_date", to)
				.order("air_date", { ascending: true })
				.order("channel", { ascending: true })
				.range(offset, offset + CHUNK_SIZE - 1);
			if (error || !data) break;
			for (const r of data as Array<{ channel: string; air_date: string }>) {
				const day = (counts[r.air_date] ??= {});
				day[r.channel] = (day[r.channel] ?? 0) + 1;
			}
			if (data.length < CHUNK_SIZE) break;
		}
	};

	await Promise.all([
		drainTable("broadcasts"),
		drainTable("historical_broadcasts"),
	]);

	return counts;
}
```

Diff vs current:
- Removed `import type { SupabaseClient } from "@supabase/supabase-js"`
- Added `import { getServiceClient } from "@/lib/supabase"`
- Function signature changed: `(sb, from, to)` → `(from, to)`
- First line of function body now does `const sb = getServiceClient();`
- Docstring updated to note service-role usage + gate expectations.

- [ ] **Step 2: Update the page call site**

File: `app/[locale]/(market)/broadcasts/page.tsx`

Find:
```ts
const initialCounts = await aggregateCalendarCounts(sb, from, to);
```

Replace with:
```ts
const initialCounts = await aggregateCalendarCounts(from, to);
```

The `sb` variable is still needed below for the OA + QVC/ShopCh count queries — leave the rest of the file untouched in this task. (Those queries get moved in Task 4.)

- [ ] **Step 3: Update the API route call site**

File: `app/api/broadcasts/calendar-counts/route.ts`

Find:
```ts
const counts = await aggregateCalendarCounts(auth.sb, from, to);
```

Replace with:
```ts
const counts = await aggregateCalendarCounts(from, to);
```

`auth.sb` is no longer used in this handler after the change. Remove the now-unused destructure if the auth result is no longer accessed; otherwise leave intact. Inspect:
- If `auth.sb` is referenced anywhere else in the file → leave the destructure
- If not → change `const auth = await requireUser(...)` usage so only the gate runs; the `sb` does not need to be unpacked. (Reading the current file: only the gate matters.)

- [ ] **Step 4: Verify build + types**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build completes, no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/broadcasts/aggregate-counts.ts \
  "app/[locale]/(market)/broadcasts/page.tsx" \
  app/api/broadcasts/calendar-counts/route.ts
git commit -m "$(cat <<'EOF'
refactor(broadcasts): drop SupabaseClient arg from aggregateCalendarCounts

Pre-requisite for wrapping the helper in a Next.js Cache Components
'use cache' boundary — cache keys must be serialisable. Both callers
(/broadcasts page + /api/broadcasts/calendar-counts) are already gated
to member/admin where the broadcasts/historical_broadcasts data is the
same for all reachable roles, so moving to service-role is
behaviour-equivalent.
EOF
)"
```

---

## Task 3: Create cached helpers (`lib/broadcasts/cached.ts`)

**Files:**
- Create: `lib/broadcasts/cached.ts`

**Rationale:** Two cached entry points — calendar window counts (per-month tag) and channel totals (single tag). Page and API route will switch to these in Task 4 / optionally later.

- [ ] **Step 1: Create the cached module**

Path: `lib/broadcasts/cached.ts`

```ts
import "server-only";
import { unstable_cacheLife as cacheLife, unstable_cacheTag as cacheTag } from "next/cache";
import { getServiceClient } from "@/lib/supabase";
import { aggregateCalendarCounts, type CountsByDate } from "./aggregate-counts";

const OA_CHANNEL_SLUGS = [
	"japanet",
	"junsanpo",
	"ntv",
	"tbs",
	"dinos",
	"senobura",
	"uranoura",
	"txd",
	"ropping",
	"kantv",
] as const;

const TV_CHANNEL_SLUGS = ["qvc", "shopch"] as const;

/**
 * Cached month-window calendar counts. Tag is keyed by the from-date's
 * YYYY-MM; cron routes call `revalidateTag` with the same shape after
 * each scrape. cacheLife is a fail-safe in case a cron skips the
 * invalidation call.
 */
export async function getCachedCalendarCounts(
	from: string,
	to: string,
): Promise<CountsByDate> {
	"use cache";
	cacheTag(`broadcasts:calendar:${from.slice(0, 7)}`);
	cacheLife({ revalidate: 60 * 60 * 6, expire: 60 * 60 * 24 });
	return aggregateCalendarCounts(from, to);
}

/**
 * Cached per-channel total counts (across all dates). Used for the
 * (N) labels on channel chips in the search overlay. Single tag —
 * invalidated whenever any cron adds rows.
 */
export async function getCachedChannelTotals(): Promise<Record<string, number>> {
	"use cache";
	cacheTag("broadcasts:totals");
	cacheLife({ revalidate: 60 * 60 * 6, expire: 60 * 60 * 24 });

	const sb = getServiceClient();

	const tvCounts = await Promise.all(
		TV_CHANNEL_SLUGS.map(async (slug) => {
			const { count } = await sb
				.from("broadcasts")
				.select("id", { count: "exact", head: true })
				.eq("channel", slug);
			return [slug, count ?? 0] as const;
		}),
	);
	const oaCounts = await Promise.all(
		OA_CHANNEL_SLUGS.map(async (slug) => {
			const { count } = await sb
				.from("historical_broadcasts")
				.select("id", { count: "exact", head: true })
				.eq("channel", slug);
			return [slug, count ?? 0] as const;
		}),
	);

	return Object.fromEntries([...tvCounts, ...oaCounts]);
}
```

Notes:
- `unstable_cacheLife` / `unstable_cacheTag` — Next.js 16 currently exposes Cache Components APIs under the `unstable_` prefix from `next/cache`. If the package re-exports stable names (`cacheLife`/`cacheTag`) by the time of execution, the import aliasing here still works because we alias to the stable names.
- `OA_CHANNEL_SLUGS` is duplicated from `app/[locale]/(market)/broadcasts/page.tsx`. Page will lose its copy in Task 4 (single source of truth: this module).
- Service client is created lazily inside `getCachedChannelTotals` (not module-scope) to avoid any side effects at import time.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build completes. The `'use cache'` directive triggers Next.js static analysis — if any of the cache-key serialisation rules are violated, the build fails here with a specific message. If it fails because of the `unstable_` import names, switch to the stable names (`import { cacheLife, cacheTag } from "next/cache"`) and re-run.

- [ ] **Step 3: Commit**

```bash
git add lib/broadcasts/cached.ts
git commit -m "$(cat <<'EOF'
feat(broadcasts): add cached calendar + channel-totals helpers

Two 'use cache' wrappers ready for the /broadcasts page (wired in next
commit). cacheTag is per-YYYY-MM for the calendar window and single-key
for totals; cacheLife({ revalidate: 6h, expire: 24h }) is the safety net
when cron-driven revalidateTag calls fail or are skipped.
EOF
)"
```

---

## Task 4: Wire `/broadcasts` page to use cached helpers

**Files:**
- Modify: `app/[locale]/(market)/broadcasts/page.tsx`

- [ ] **Step 1: Replace inline queries with cached helpers**

File: `app/[locale]/(market)/broadcasts/page.tsx`

Replace the full file with:

```tsx
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import BroadcastCalendar from "@/components/broadcasts/BroadcastCalendar";
import BroadcastSearchOverlay from "@/components/broadcasts/BroadcastSearchOverlay";
import { localePath } from "@/lib/i18n/locale-path";
import {
	getCachedCalendarCounts,
	getCachedChannelTotals,
} from "@/lib/broadcasts/cached";

interface PageProps {
	params: Promise<{ locale: string }>;
	searchParams: Promise<{ date?: string; ch?: string }>;
}

function pad2(n: number) {
	return String(n).padStart(2, "0");
}

function monthBoundsAround(iso: string): { y: number; m: number; from: string; to: string } {
	const [yy, mm] = iso.split("-").map((x) => parseInt(x, 10));
	const prevY = mm === 1 ? yy - 1 : yy;
	const prevM = mm === 1 ? 12 : mm - 1;
	const nextY = mm === 12 ? yy + 1 : yy;
	const nextM = mm === 12 ? 1 : mm + 1;
	const prevLast = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
	const nextLast = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
	return {
		y: yy,
		m: mm,
		from: `${prevY}-${pad2(prevM)}-${pad2(Math.max(prevLast - 6, 1))}`,
		to: `${nextY}-${pad2(nextM)}-${pad2(Math.min(nextLast, 7))}`,
	};
}

export default async function Page({ params, searchParams }: PageProps) {
	const { locale } = await params;
	const sp = await searchParams;
	const t = await getTranslations({ locale, namespace: "broadcasts" });

	// Auth gate — per-request, NOT cached. requireUser must run before any
	// cached data is read so unauthenticated users are redirected before
	// touching the data layer.
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) {
		redirect(localePath(locale, "/login"));
	}

	const today = new Date();
	const todayIso = today.toISOString().slice(0, 10);
	const selected = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso;
	const { y, m, from, to } = monthBoundsAround(selected);

	// Cached: keyed by from-month + a single global totals tag. Cron
	// routes invalidate via revalidateTag.
	const [initialCounts, channelCounts] = await Promise.all([
		getCachedCalendarCounts(from, to),
		getCachedChannelTotals(),
	]);

	const hasAny = Object.keys(initialCounts).length > 0;

	return (
		<>
			<div className="flex justify-end mb-6">
				<BroadcastSearchOverlay channelCounts={channelCounts} />
			</div>

			{!hasAny ? (
				<div className="text-sm text-muted-foreground p-12 text-center border border-dashed border-border rounded-lg">
					{t("empty.all")}
				</div>
			) : (
				<BroadcastCalendar
					initialYear={y}
					initialMonth={m}
					initialDate={selected}
					initialCounts={initialCounts}
				/>
			)}
		</>
	);
}
```

Diff vs current:
- Removed `aggregateCalendarCounts` import + `OA_CHANNEL_SLUGS` constant
- Removed `auth.sb` usage (`sb` variable no longer needed)
- Removed the 10 OA per-channel count queries + 2 TV per-channel count queries
- Calendar counts and channel totals fetched in parallel via cached helpers
- Auth gate kept above the data reads — required: cache invocation must come AFTER the gate

- [ ] **Step 2: Verify build + types**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build completes.

- [ ] **Step 3: Local smoke run**

Run: `npm run dev` (background acceptable)
Open: `http://localhost:3000/ja/broadcasts` (login if needed with member/admin)
Expected: page renders the calendar identically to before — same channel chips, same calendar counts. Visual regression check only; cache-hit verification is post-deploy.
Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add "app/[locale]/(market)/broadcasts/page.tsx"
git commit -m "$(cat <<'EOF'
perf(broadcasts): cache /broadcasts page data fetches

Page now calls getCachedCalendarCounts + getCachedChannelTotals instead
of running 13 Supabase queries inline on every request. Auth gate runs
before the cache reads to keep RLS-bypass invisible to non-members.
EOF
)"
```

---

## Task 5: Invalidate cache from `daily-broadcasts` cron

**Files:**
- Modify: `app/api/cron/daily-broadcasts/route.ts`

- [ ] **Step 1: Replace local `getYesterdayJST` with shared helper + add `revalidateTag`**

File: `app/api/cron/daily-broadcasts/route.ts`

Top-of-file imports — add the two new imports above the existing imports:

```ts
import { revalidateTag } from "next/cache";
import { getYesterdayJST, getJSTYearMonth } from "@/lib/broadcasts/jst-date";
```

Then delete the local `getYesterdayJST` function (lines starting `function getYesterdayJST(nowUtc: Date): Date {` through its closing brace).

At the **end of the `GET` handler**, **just before** `console.log(JSON.stringify(log));`, add the cache invalidation block:

```ts
	// Invalidate page cache for the month we just wrote to. revalidateTag
	// failures are non-fatal — the cron's job is data ingest; stale cache
	// recovers via cacheLife's 6h revalidate fallback.
	try {
		const ym = getJSTYearMonth(target);
		revalidateTag(`broadcasts:calendar:${ym}`);
		revalidateTag("broadcasts:totals");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[cache] revalidateTag failed", { route: "daily-broadcasts", error: msg });
	}
```

Note: `target` is the existing variable derived from `getYesterdayJST(new Date())` already in the handler — keep that line as-is (it now uses the imported helper instead of the deleted local one).

- [ ] **Step 2: Verify type-check + build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build completes.

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/daily-broadcasts/route.ts
git commit -m "$(cat <<'EOF'
feat(cron/daily-broadcasts): invalidate /broadcasts page cache after scrape

revalidateTag('broadcasts:calendar:YYYY-MM') for the scraped JST month
plus the single global 'broadcasts:totals' tag. Errors are logged as
warnings — cron continues to 200 because data ingest, not cache
invalidation, is its primary responsibility.

Also replaces the local getYesterdayJST function with the shared helper
from lib/broadcasts/jst-date.
EOF
)"
```

---

## Task 6: Invalidate cache from `qvc-monthly-refresh` cron

**Files:**
- Modify: `app/api/cron/qvc-monthly-refresh/route.ts`

**Rationale:** This cron rescrapes QVC's previous + current month rolling window. Both YYYY-MM tags must be invalidated. The route already defines a local `jstNow()` returning the JST-shifted Date — reuse it and derive the two months directly.

- [ ] **Step 1: Add imports + invalidation block**

File: `app/api/cron/qvc-monthly-refresh/route.ts`

Top-of-file imports — add:

```ts
import { revalidateTag } from "next/cache";
import { getJSTYearMonth } from "@/lib/broadcasts/jst-date";
```

At the **end of the `GET` handler**, **just before** `console.log(JSON.stringify(log));`, add:

```ts
	// Invalidate cache for previous + current JST month. Both are
	// rewritten by refreshQVCMonthlyRange's rolling window.
	try {
		const now = jstNow();
		const currentYM = getJSTYearMonth(now);
		const prevDate = new Date(now);
		prevDate.setUTCMonth(prevDate.getUTCMonth() - 1);
		const prevYM = getJSTYearMonth(prevDate);
		revalidateTag(`broadcasts:calendar:${prevYM}`);
		revalidateTag(`broadcasts:calendar:${currentYM}`);
		revalidateTag("broadcasts:totals");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[cache] revalidateTag failed", { route: "qvc-monthly-refresh", error: msg });
	}
```

- [ ] **Step 2: Verify type-check + build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build completes.

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/qvc-monthly-refresh/route.ts
git commit -m "$(cat <<'EOF'
feat(cron/qvc-monthly-refresh): invalidate calendar cache for both months

The refresh rewrites previous + current JST month every run, so both
broadcasts:calendar:YYYY-MM tags plus broadcasts:totals are invalidated.
EOF
)"
```

---

## Task 7: Invalidate cache from `daily-historical-broadcasts` cron

**Files:**
- Modify: `app/api/cron/daily-historical-broadcasts/route.ts`

**Rationale:** This cron uses `jstToday()` (`"YYYY-MM-DD"` string) rather than a Date. Slice directly — no need for the Date-based helper here.

- [ ] **Step 1: Add import + invalidation block**

File: `app/api/cron/daily-historical-broadcasts/route.ts`

Top-of-file imports — add:

```ts
import { revalidateTag } from "next/cache";
```

The existing handler wraps the crawl in `try / catch`. Add the invalidation **inside the `try` block**, **just before** `console.log(JSON.stringify(log));` (which is the last log before the success `return`).

```ts
		// Invalidate /broadcasts page cache for the scraped JST month.
		try {
			const ym = date.slice(0, 7); // date is "YYYY-MM-DD" from jstToday()
			revalidateTag(`broadcasts:calendar:${ym}`);
			revalidateTag("broadcasts:totals");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", { route: "daily-historical-broadcasts", error: msg });
		}
```

Note: placed inside the outer `try` so partial-success crawls still invalidate. The inner `try/catch` here makes the revalidateTag failure independently non-fatal even within the outer try — the outer `catch` should still only fire on crawl failure, not cache failure.

- [ ] **Step 2: Verify type-check + build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: build completes.

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/daily-historical-broadcasts/route.ts
git commit -m "$(cat <<'EOF'
feat(cron/daily-historical-broadcasts): invalidate calendar cache after crawl

revalidateTag for the scraped JST month + the global totals tag. Wrapped
in its own try/catch so cache-side failures never propagate to the
outer crawl error handler.
EOF
)"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Full production build**

Run: `npm run build`
Expected: completes, with no warnings about `'use cache'` serialisation.

- [ ] **Step 3: Existing test suites**

Run: `npm run test:broadcasts-parsers`
Expected: passes (caching does not affect parser behaviour).

- [ ] **Step 4: Local smoke run**

Run: `npm run dev` (background acceptable)
Open: `http://localhost:3000/ja/broadcasts`
Expected:
- Page renders the calendar grid identically to before
- Channel chips show the same (N) labels
- Searching by channel still returns results
- Switching months in the UI still works (the API route `calendar-counts` was refactored in Task 2 but kept uncached — behaviour unchanged)

Stop dev server.

- [ ] **Step 5: Post-deploy manual verification (note in PR description)**

Add the following to the PR description for the reviewer:

```
## Post-deploy verification checklist
After merge & production deploy:

1. Open Supabase dashboard → API logs. Note baseline.
2. Visit /ja/broadcasts (logged-in member/admin). Expect ~13 reads
   (1 calendar-window batched + 12 channel counts).
3. Refresh the same page. Expect 0 broadcasts/historical_broadcasts
   reads (cache hit). Only auth-related reads remain.
4. Wait for the next daily-broadcasts cron (~JST 01:00) and refresh.
   Expect the calendar-window reads to fire again (cache invalidated).
5. Refresh once more. Expect 0 again (cache repopulated).
```

---

## Self-review notes

Spec coverage check vs `docs/superpowers/specs/2026-05-24-broadcasts-page-caching-design.md`:

- §4 architecture (page + cached.ts + jst-date.ts + 3 crons) — covered T1, T3, T4, T5, T6, T7
- §4.1.1 service-client RLS bypass — T3 step 1 (getServiceClient inside cached helpers + inside aggregateCalendarCounts after T2)
- §4.1.2 signature change — T2
- §4.1.3 auth gate outside cache — T4 step 1 (gate above cached calls in page.tsx)
- §4.1.4 `server-only` import — T3 step 1 (first line of cached.ts)
- §5.1 cache keys + cacheLife — T3 step 1
- §5.2 invalidation chain (3 crons, 2-3 tags each) — T5, T6, T7
- §6 error handling (try/catch around revalidateTag, log warn) — T5/T6/T7 each have the try/catch block
- §7 verification (build + manual) — T8
- §8 rollback — implicit; all changes are additive or single-call-site refactors

Spec gap noticed during planning: spec said "호출처는 페이지 한 곳뿐이라 안전" but `app/api/broadcasts/calendar-counts/route.ts` is a second caller. Plan accounts for this in T2; no further design change needed since RLS-bypass safety argument applies identically (route is also gated to member/admin).

Placeholder scan: none found.

Type consistency: function names `getCachedCalendarCounts`, `getCachedChannelTotals`, `getYesterdayJST`, `getJSTYearMonth`, `aggregateCalendarCounts` consistent across tasks. Tag string format `broadcasts:calendar:${YYYY-MM}` + `broadcasts:totals` consistent everywhere.
