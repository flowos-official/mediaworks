# Unified Day Detail Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the right-side `DayDetailPanel` (QVC + ShopCh) and the bottom `HistoricalBroadcasts` (8 OA channels) into a single unified per-day list, while keeping free-text history search as a separate, date-independent section below.

**Architecture:** A new `UnifiedDayDetailPanel` replaces `DayDetailPanel` in `BroadcastCalendar`'s right column. It parallel-fetches both broadcast tables for the selected date, partitions into "timed" (QVC/ShopCh) and "OA" (8 channels) sections, and renders one chip-filterable list. The existing `HistoricalBroadcasts` is repurposed as a search-only panel — `urlDate` coupling removed.

**Tech Stack:** Next.js App Router, React Server Components, TypeScript, `next-intl`, Tailwind, existing `/api/broadcasts` + `/api/historical-broadcasts` endpoints.

---

## Context for the engineer

- Spec: `docs/superpowers/specs/2026-05-17-unified-day-detail-panel-design.md` — full design rationale.
- Existing right-side panel: `components/broadcasts/DayDetailPanel.tsx` (will be deleted).
- Existing OA panel: `components/broadcasts/HistoricalBroadcasts.tsx` (will be modified — date coupling removed).
- Parent: `components/broadcasts/BroadcastCalendar.tsx` (sticky wrapper applied in PR #49 stays).
- SSR page: `app/[locale]/broadcasts/page.tsx`.
- No new APIs. `/api/broadcasts` returns rows with `category` (PR #43); `/api/historical-broadcasts` returns rows with `category` (PR #43). Both use `auth.sb`.
- The 8 OA channel slugs and badge palette live inside `HistoricalBroadcasts.tsx` today (`OA_CHANNELS` + `CHANNEL_BADGE`). The plan extracts them so `UnifiedDayDetailPanel` can reuse without duplication.
- No test framework — verification steps are manual (curl + browser).

## File Structure

**Create:**
- `lib/broadcasts/channel-style.ts` — `OA_CHANNELS` constant + `CHANNEL_BADGE` palette extracted from `HistoricalBroadcasts.tsx`, also adds `QVC_SHOPCH_BADGE` and a helper `channelDisplayName(slug)`. One source of truth so both panels stay consistent.
- `components/broadcasts/OABroadcastListItem.tsx` — row presenter for an OA row: channel badge + product_name + price.
- `components/broadcasts/UnifiedDayDetailPanel.tsx` — replaces `DayDetailPanel`. Fetches both tables on `date` change, renders chips + 時間順 + OA sections.

**Modify:**
- `components/broadcasts/HistoricalBroadcasts.tsx` — drop `urlDate` / `initialDate` coupling; component becomes search-only.
- `components/broadcasts/BroadcastCalendar.tsx` — swap `DayDetailPanel` for `UnifiedDayDetailPanel`.
- `app/[locale]/broadcasts/page.tsx` — SSR no longer fetches historical-by-selected-date; `HistoricalBroadcasts` initial state is empty.
- `messages/ja.json` — add `broadcasts.unified.*` keys + change `broadcasts.historical.titleForDate` → `broadcasts.historical.searchTitle`.
- `messages/ko.json` — same.
- `CLAUDE.md` — update Broadcast Calendar section to describe the unified layout.

**Delete:**
- `components/broadcasts/DayDetailPanel.tsx`.

---

## Task 1: Extract shared channel-style helpers

**Files:**
- Create: `lib/broadcasts/channel-style.ts`

- [ ] **Step 1: Write the helper file**

```ts
// lib/broadcasts/channel-style.ts
// Shared channel metadata + badge palette for broadcasts UI. Single source
// of truth so DayDetailPanel and HistoricalBroadcasts stay consistent.

export type BroadcastChannelSlug =
	| "qvc"
	| "shopch"
	| "japanet"
	| "junsanpo"
	| "ntv"
	| "tbs"
	| "dinos"
	| "senobura"
	| "uranoura"
	| "btops";

export const OA_CHANNELS: { slug: BroadcastChannelSlug; name: string }[] = [
	{ slug: "japanet", name: "ジャパネット" },
	{ slug: "junsanpo", name: "テレ朝じゅん散歩" },
	{ slug: "ntv", name: "日テレポシュレ" },
	{ slug: "tbs", name: "TBSキニナル" },
	{ slug: "dinos", name: "フジDinos" },
	{ slug: "senobura", name: "ABCせのぶら" },
	{ slug: "uranoura", name: "ABCウラのウラまで" },
	{ slug: "btops", name: "読売B-tops" },
];

export const ALL_CHANNELS: { slug: BroadcastChannelSlug; name: string }[] = [
	{ slug: "qvc", name: "QVC" },
	{ slug: "shopch", name: "Shop CH" },
	...OA_CHANNELS,
];

export const CHANNEL_BADGE: Record<BroadcastChannelSlug, string> = {
	qvc: "bg-purple-100 text-purple-800 border-purple-200",
	shopch: "bg-red-100 text-red-800 border-red-200",
	japanet: "bg-red-100 text-red-800 border-red-200",
	junsanpo: "bg-cyan-100 text-cyan-800 border-cyan-200",
	ntv: "bg-amber-100 text-amber-800 border-amber-200",
	tbs: "bg-sky-100 text-sky-800 border-sky-200",
	dinos: "bg-rose-100 text-rose-800 border-rose-200",
	senobura: "bg-indigo-100 text-indigo-800 border-indigo-200",
	uranoura: "bg-purple-100 text-purple-800 border-purple-200",
	btops: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

export function channelDisplayName(slug: string): string {
	const found = ALL_CHANNELS.find((c) => c.slug === slug);
	return found?.name ?? slug;
}

export function isOAChannel(slug: string): boolean {
	return OA_CHANNELS.some((c) => c.slug === slug);
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/broadcasts/channel-style.ts
git commit -m "feat(broadcasts): shared channel metadata + badge palette"
```

---

## Task 2: OABroadcastListItem row presenter

**Files:**
- Create: `components/broadcasts/OABroadcastListItem.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { ExternalLink } from "lucide-react";
import { CHANNEL_BADGE, channelDisplayName } from "@/lib/broadcasts/channel-style";

export interface OARow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	category: string | null;
}

function formatPrice(row: OARow): string {
	if (row.price_jpy == null) return row.price_text ?? "—";
	const fmt = `¥${row.price_jpy.toLocaleString("ja-JP")}`;
	if (row.price_is_tax_incl === false) return `${fmt}（税抜）`;
	return fmt;
}

export default function OABroadcastListItem({ row }: { row: OARow }) {
	const badge =
		CHANNEL_BADGE[row.channel as keyof typeof CHANNEL_BADGE] ??
		"bg-gray-100 text-gray-700 border-gray-200";
	return (
		<div className="flex items-start gap-3 py-2 px-3 border-b border-gray-100 last:border-b-0 hover:bg-gray-50/50">
			<span
				className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${badge}`}
			>
				{channelDisplayName(row.channel)}
			</span>
			<div className="flex-1 min-w-0">
				<div className="text-sm text-gray-900 truncate">{row.product_name}</div>
				{row.category && (
					<div className="text-[10px] text-gray-500 mt-0.5">{row.category}</div>
				)}
			</div>
			<div className="shrink-0 text-right text-xs text-gray-700 font-mono whitespace-nowrap">
				{formatPrice(row)}
			</div>
			{row.source_url && (
				<a
					href={row.source_url}
					target="_blank"
					rel="noopener noreferrer"
					className="shrink-0 text-gray-400 hover:text-gray-700"
					aria-label="external link"
				>
					<ExternalLink size={14} />
				</a>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Commit**

```bash
git add components/broadcasts/OABroadcastListItem.tsx
git commit -m "feat(broadcasts): OABroadcastListItem row presenter"
```

---

## Task 3: UnifiedDayDetailPanel component

**Files:**
- Create: `components/broadcasts/UnifiedDayDetailPanel.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import BroadcastListItem, {
	type Broadcast,
} from "./BroadcastListItem";
import OABroadcastListItem, { type OARow } from "./OABroadcastListItem";
import {
	ALL_CHANNELS,
	CHANNEL_BADGE,
	channelDisplayName,
	isOAChannel,
	type BroadcastChannelSlug,
} from "@/lib/broadcasts/channel-style";

const CATEGORIES_BY_CHANNEL: Record<"qvc" | "shopch", readonly string[]> = {
	qvc: [
		"ビューティー",
		"ファッション小物",
		"健康・ダイエット",
		"ホーム",
		"キッチングッズ",
		"レジャー・ホビー",
		"家電",
	],
	shopch: [
		"靴・バッグ・小物・インナー",
		"コスメ",
		"美容・ダイエット・フィットネス",
		"ホーム・インテリア",
		"家電",
	],
};

interface Props {
	date: string | null;
}

function formatDateLabel(iso: string): string {
	const [y, m, d] = iso.split("-");
	return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

export default function UnifiedDayDetailPanel({ date }: Props) {
	const t = useTranslations("broadcasts");
	const [channelFilter, setChannelFilter] = useState<string>("all");
	const [categoryFilter, setCategoryFilter] = useState<string>("all");
	const [timedRows, setTimedRows] = useState<Broadcast[]>([]);
	const [oaRows, setOaRows] = useState<OARow[]>([]);
	const [loading, setLoading] = useState(false);
	const [timedError, setTimedError] = useState(false);
	const [oaError, setOaError] = useState(false);

	const fetchDay = useCallback(async (iso: string, signal: AbortSignal) => {
		setLoading(true);
		setTimedError(false);
		setOaError(false);
		const [bRes, hRes] = await Promise.allSettled([
			fetch(`/api/broadcasts?from=${iso}&to=${iso}`, { signal }),
			fetch(`/api/historical-broadcasts?date=${iso}&limit=500`, { signal }),
		]);

		if (bRes.status === "fulfilled" && bRes.value.ok) {
			const json = (await bRes.value.json()) as { broadcasts: Broadcast[] };
			setTimedRows(json.broadcasts ?? []);
		} else {
			setTimedRows([]);
			if (bRes.status === "fulfilled" || !(bRes.reason instanceof DOMException)) {
				setTimedError(true);
			}
		}

		if (hRes.status === "fulfilled" && hRes.value.ok) {
			const json = (await hRes.value.json()) as { rows: OARow[] };
			setOaRows(json.rows ?? []);
		} else {
			setOaRows([]);
			if (hRes.status === "fulfilled" || !(hRes.reason instanceof DOMException)) {
				setOaError(true);
			}
		}
		setLoading(false);
	}, []);

	useEffect(() => {
		if (!date) return;
		const ctrl = new AbortController();
		void fetchDay(date, ctrl.signal);
		return () => ctrl.abort();
	}, [date, fetchDay]);

	if (!date) {
		return (
			<div className="text-sm text-gray-500 p-6 text-center">
				{t("empty.day")}
			</div>
		);
	}

	// Apply chip filters.
	const matchesFilters = (channel: string, category: string | null): boolean => {
		if (channelFilter !== "all" && channel !== channelFilter) return false;
		if (categoryFilter === "all") return true;
		return category === categoryFilter;
	};
	const filteredTimed = timedRows.filter((b) =>
		matchesFilters(b.channel, b.category ?? null),
	);
	const filteredOA = oaRows.filter((r) =>
		matchesFilters(r.channel, r.category),
	);
	const totalShown = filteredTimed.length + filteredOA.length;

	// Per-channel counts (after category filter) for chip labels.
	const channelCount = (slug: string): number => {
		const fromTimed = timedRows.filter(
			(b) => b.channel === slug && (categoryFilter === "all" || b.category === categoryFilter),
		).length;
		const fromOA = oaRows.filter(
			(r) => r.channel === slug && (categoryFilter === "all" || r.category === categoryFilter),
		).length;
		return fromTimed + fromOA;
	};

	// Visible category chip set:
	// channelFilter==="all" -> union of qvc + shopch whitelists.
	// channelFilter is qvc/shopch -> that channel's whitelist.
	// channelFilter is an OA channel -> hidden (no whitelist).
	const showCategoryChips =
		channelFilter === "all" || channelFilter === "qvc" || channelFilter === "shopch";
	const visibleCategories: readonly string[] = !showCategoryChips
		? []
		: channelFilter === "all"
			? Array.from(
					new Set([...CATEGORIES_BY_CHANNEL.qvc, ...CATEGORIES_BY_CHANNEL.shopch]),
				)
			: CATEGORIES_BY_CHANNEL[channelFilter as "qvc" | "shopch"];

	const sortedTimed = [...filteredTimed].sort((a, b) => {
		if (a.start_time !== b.start_time) return a.start_time.localeCompare(b.start_time);
		return a.channel.localeCompare(b.channel);
	});

	const oaByChannel = new Map<string, OARow[]>();
	for (const row of filteredOA) {
		const list = oaByChannel.get(row.channel) ?? [];
		list.push(row);
		oaByChannel.set(row.channel, list);
	}

	return (
		<div>
			<div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
				<div>
					<h2 className="text-xl font-semibold text-gray-900">
						{formatDateLabel(date)}
					</h2>
					<p className="text-xs text-gray-500">
						{loading ? t("loading") : t("broadcastCount", { count: totalShown })}
					</p>
				</div>
			</div>

			{/* Channel chips */}
			<div className="flex flex-wrap gap-1.5 mb-3">
				<button
					type="button"
					onClick={() => setChannelFilter("all")}
					className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
						channelFilter === "all"
							? "bg-gray-900 text-white border-gray-900"
							: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
					}`}
				>
					{t("channelFilter.all")}
				</button>
				{ALL_CHANNELS.map(({ slug, name }) => {
					const n = channelCount(slug);
					const active = channelFilter === slug;
					const palette =
						CHANNEL_BADGE[slug as BroadcastChannelSlug] ??
						"bg-gray-100 text-gray-700 border-gray-200";
					return (
						<button
							key={slug}
							type="button"
							onClick={() => {
								setChannelFilter(slug);
								// If user picks an OA channel, drop category filter
								// since OA has no whitelist.
								if (isOAChannel(slug) && categoryFilter !== "all") {
									setCategoryFilter("all");
								}
							}}
							className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
								active
									? "bg-gray-900 text-white border-gray-900"
									: `${palette} hover:opacity-80`
							}`}
						>
							{name} ({n})
						</button>
					);
				})}
			</div>

			{/* Category chips */}
			{showCategoryChips && (
				<div className="flex flex-wrap gap-1.5 mb-3">
					<button
						type="button"
						onClick={() => setCategoryFilter("all")}
						className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
							categoryFilter === "all"
								? "bg-gray-900 text-white border-gray-900"
								: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
						}`}
					>
						{t("categoryFilter.all")}
					</button>
					{visibleCategories.map((c) => (
						<button
							key={c}
							type="button"
							onClick={() => setCategoryFilter(c)}
							className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
								categoryFilter === c
									? "bg-gray-900 text-white border-gray-900"
									: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
							}`}
						>
							{c}
						</button>
					))}
				</div>
			)}

			{/* Sections */}
			{totalShown === 0 && !loading ? (
				<div className="text-sm text-gray-500 p-6 text-center border border-dashed border-gray-200 rounded-lg">
					{timedRows.length + oaRows.length === 0
						? t("empty.day")
						: t("empty.filtered")}
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{sortedTimed.length > 0 && (
						<section>
							<div className="text-xs font-medium text-gray-500 mb-2">
								─ {t("unified.timedSection")} ({sortedTimed.length}件)
								{timedError ? ` · ${t("unified.fetchFailed")}` : ""}
							</div>
							<div className="flex flex-col gap-2">
								{sortedTimed.map((b) => (
									<BroadcastListItem key={b.id} broadcast={b} />
								))}
							</div>
						</section>
					)}
					{filteredOA.length > 0 && (
						<section>
							<div className="text-xs font-medium text-gray-500 mb-2">
								─ {t("unified.oaSection")} ({filteredOA.length}件)
								{oaError ? ` · ${t("unified.fetchFailed")}` : ""}
							</div>
							<div className="rounded-lg border border-gray-200">
								{[...oaByChannel.entries()]
									.sort(([a], [b]) => a.localeCompare(b))
									.flatMap(([_, rows]) =>
										rows.map((r) => <OABroadcastListItem key={r.id} row={r} />),
									)}
							</div>
						</section>
					)}
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Commit**

```bash
git add components/broadcasts/UnifiedDayDetailPanel.tsx
git commit -m "feat(broadcasts): UnifiedDayDetailPanel — 12 channels, timed + OA sections"
```

---

## Task 4: BroadcastCalendar swap

**Files:**
- Modify: `components/broadcasts/BroadcastCalendar.tsx`

- [ ] **Step 1: Replace import + render**

Remove `DayDetailPanel` import, all category/channel filter state (no longer owned by the parent — the unified panel manages its own state), and the `?cat=` URL plumbing introduced in PR #39. Render `<UnifiedDayDetailPanel date={selectedDate} />` instead.

Diff:

```diff
- import type { ChannelFilterValue } from "./ChannelFilter";
- import DayDetailPanel from "./DayDetailPanel";
+ import UnifiedDayDetailPanel from "./UnifiedDayDetailPanel";
```

```diff
   const [year, setYear] = useState(initialYear);
   const [month, setMonth] = useState(initialMonth);
   const [selectedDate, setSelectedDate] = useState<string | null>(initialDate);
-  const [channelFilter, setChannelFilter] = useState<ChannelFilterValue>(
-    (searchParams.get("ch") as ChannelFilterValue) ?? "all",
-  );
-  const [categoryFilter, setCategoryFilter] = useState<string>(
-    searchParams.get("cat") ?? "all",
-  );
```

Replace `syncUrl` with a date-only version:

```ts
const syncUrl = useCallback(
  (date: string | null) => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  },
  [router],
);
```

Remove `handleFilterChange` and `handleCategoryFilterChange`. Update `handleDateClick` to call `syncUrl(iso)`.

Replace the render of the right column:

```diff
-      <div className="md:max-h-[calc(100vh-12rem)] md:overflow-y-auto md:sticky md:top-4 pr-1">
-        <DayDetailPanel
-          date={selectedDate}
-          broadcasts={dayBroadcasts}
-          channelFilter={channelFilter}
-          onChannelFilterChange={handleFilterChange}
-          categoryFilter={categoryFilter}
-          onCategoryFilterChange={handleCategoryFilterChange}
-        />
+      <div className="md:max-h-[calc(100vh-12rem)] md:overflow-y-auto md:sticky md:top-4 pr-1">
+        <UnifiedDayDetailPanel date={selectedDate} />
       </div>
```

`dayBroadcasts` and `currentMonthData` consumers should be re-examined. The month-bounded cache (`cache: Map<string, Broadcast[]>`) is now only used by the month grid for cell counts — keep that fetch. Remove the `dayBroadcasts` `useMemo` (no longer used).

- [ ] **Step 2: Verify type check**

Run: `npx tsc --noEmit 2>&1 | grep -v "^\.next" | grep -v "scripts/.*pg"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/broadcasts/BroadcastCalendar.tsx
git commit -m "feat(broadcasts): swap DayDetailPanel for UnifiedDayDetailPanel"
```

---

## Task 5: HistoricalBroadcasts — drop date coupling

**Files:**
- Modify: `components/broadcasts/HistoricalBroadcasts.tsx`

- [ ] **Step 1: Remove urlDate effect and initialDate prop**

```diff
 interface Props {
   initialRows: HistoricalBroadcastRow[];
   initialTotal: number;
-  initialDate: string;
   channelCounts: Record<string, number>;
 }
```

```diff
   const t = useTranslations("broadcasts.historical");
-  const searchParams = useSearchParams();
-  const urlDate = searchParams.get("date") ?? initialDate;
-
-  const [date, setDate] = useState<string>(urlDate);
   const [channel, setChannel] = useState<string>("all");
   const [category, setCategory] = useState<string>("all");
   const [search, setSearch] = useState("");
   const [searchInput, setSearchInput] = useState("");
   const [rows, setRows] = useState<HistoricalBroadcastRow[]>(initialRows);
   const [total, setTotal] = useState(initialTotal);
   const [offset, setOffset] = useState(0);
   const [loading, setLoading] = useState(false);
-
-  // React to URL date param changes from BroadcastCalendar...
-  useEffect(() => {
-    if (urlDate !== date) {
-      setDate(urlDate);
-      ...
-    }
-  }, [urlDate, date]);
```

`fetchPage` only sends `search`, `channel`, `category`, `limit`, `offset` — never `date`:

```ts
const fetchPage = useCallback(
  async (
    nextChannel: string,
    nextCategory: string,
    nextSearch: string,
    nextOffset: number,
    signal?: AbortSignal,
  ) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (nextSearch) qs.set("search", nextSearch);
      if (nextChannel !== "all") qs.set("channel", nextChannel);
      if (nextCategory !== "all") qs.set("category", nextCategory);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(nextOffset));
      const r = await fetch(`/api/historical-broadcasts?${qs}`, { signal });
      if (!r.ok) throw new Error(r.statusText);
      const json = (await r.json()) as {
        rows: HistoricalBroadcastRow[];
        total: number;
      };
      setRows(json.rows);
      setTotal(json.total);
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") console.error(e);
    } finally {
      setLoading(false);
    }
  },
  [],
);

useEffect(() => {
  // Only fetch when a search term is present; otherwise stay empty.
  if (!search && channel === "all" && category === "all" && offset === 0) {
    return;
  }
  const ctrl = new AbortController();
  void fetchPage(channel, category, search, offset, ctrl.signal);
  return () => ctrl.abort();
}, [channel, category, search, offset, fetchPage]);
```

- [ ] **Step 2: Replace header text**

Replace `t("titleForDate", { date })` with `t("searchTitle")` (key added in Task 7).

- [ ] **Step 3: Update empty state**

Replace the `t("emptyForDate", { date })` empty-state copy with `t("emptyNoQuery")`.

- [ ] **Step 4: Commit**

```bash
git add components/broadcasts/HistoricalBroadcasts.tsx
git commit -m "feat(broadcasts): HistoricalBroadcasts becomes search-only (no date coupling)"
```

---

## Task 6: page.tsx — drop historical date fetch

**Files:**
- Modify: `app/[locale]/broadcasts/page.tsx`

- [ ] **Step 1: Remove the historical date-bound query**

```diff
-  const [{ data: historicalData, count: historicalTotal }, channelCountResults] =
-    await Promise.all([
-      sb
-        .from("historical_broadcasts")
-        .select(
-          "id,channel,air_date,day_of_week,product_name,price_text,price_jpy,price_is_tax_incl,source_url,category",
-          { count: "exact" },
-        )
-        .eq("air_date", selected)
-        .order("channel", { ascending: true })
-        .range(0, 49),
-      Promise.all(
+  const channelCountResults = await Promise.all(
         OA_CHANNEL_SLUGS.map(async (slug) => {
           const { count } = await sb
             .from("historical_broadcasts")
             .select("id", { count: "exact", head: true })
             .eq("channel", slug);
           return [slug, count ?? 0] as const;
         }),
-      ),
-    ]);
+      );
```

```diff
-  const initialHistorical = (historicalData ?? []) as HistoricalBroadcastRow[];
   const channelCounts: Record<string, number> = Object.fromEntries(channelCountResults);
```

```diff
       <HistoricalBroadcasts
-        initialRows={initialHistorical}
-        initialTotal={historicalTotal ?? 0}
-        initialDate={selected}
+        initialRows={[]}
+        initialTotal={0}
         channelCounts={channelCounts}
       />
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -v "^\.next" | grep -v "scripts/.*pg"`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/[locale]/broadcasts/page.tsx
git commit -m "feat(broadcasts): page SSR no longer fetches historical for selected date"
```

---

## Task 7: i18n keys

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`

- [ ] **Step 1: Add new keys to `messages/ja.json`** under the existing `broadcasts` block

```json
"channelFilter": {
  "all": "全て"
},
"unified": {
  "timedSection": "時間順 (QVC + ShopCh)",
  "oaSection": "OA チャネル (時間情報なし)",
  "fetchFailed": "取得失敗"
},
"loading": "読み込み中…",
```

Inside `broadcasts.historical`, change/replace:

```json
"searchTitle": "全履歴検索 (8 OA channels)",
"emptyNoQuery": "検索ワードを入力してください。"
```

(Existing `titleForDate` and `emptyForDate` keys are no longer used by the component; leave them for now, or remove if you want to clean up — they don't conflict.)

- [ ] **Step 2: Mirror to `messages/ko.json`**

```json
"channelFilter": {
  "all": "전체"
},
"unified": {
  "timedSection": "시간순 (QVC + ShopCh)",
  "oaSection": "OA 채널 (시간 정보 없음)",
  "fetchFailed": "가져오기 실패"
},
"loading": "로딩 중…",
```

Inside `broadcasts.historical`:

```json
"searchTitle": "전체 이력 검색 (OA 8채널)",
"emptyNoQuery": "검색어를 입력해주세요."
```

- [ ] **Step 3: Commit**

```bash
git add messages/ja.json messages/ko.json
git commit -m "i18n(broadcasts): unified panel keys + search-only historical keys"
```

---

## Task 8: Delete DayDetailPanel

**Files:**
- Delete: `components/broadcasts/DayDetailPanel.tsx`

- [ ] **Step 1: Confirm no remaining references**

Run: `grep -rn "DayDetailPanel" components app | grep -v ".next"`
Expected: only references inside the file itself (or zero).

- [ ] **Step 2: Delete the file**

```bash
git rm components/broadcasts/DayDetailPanel.tsx
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove DayDetailPanel (replaced by UnifiedDayDetailPanel)"
```

---

## Task 9: CLAUDE.md note

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the broadcast UI bullet**

Find the line under "Broadcast Calendar (Phase A — read-only)" that mentions the `/[locale]/broadcasts` UI (the line near the top of the bullet list that reads something like "UI: `/[locale]/broadcasts` — month grid + time-sorted unified day list with channel filter.") and replace with:

```markdown
- UI: `/[locale]/broadcasts` — month grid + sticky right-side `UnifiedDayDetailPanel` (covers all 12 channels: QVC, ShopCh, and 8 OA channels in one list, with channel + category chip filters). Below the calendar, a separate `HistoricalBroadcasts` panel offers free-text history search across the 8 OA channels (no date coupling).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): unified day panel layout"
```

---

## Task 10: Final type check + push + PR + merge

- [ ] **Step 1: Final typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "^\.next" | grep -v "scripts/.*pg" | head -10
```

Expected: empty output.

- [ ] **Step 2: Push and create PR**

```bash
git push -u origin feat/unified-day-detail-panel
gh pr create --base main --title "feat(broadcasts): unified per-day panel + search-only history" --body "$(cat <<'EOF'
## Summary
Spec: `docs/superpowers/specs/2026-05-17-unified-day-detail-panel-design.md`

- New `UnifiedDayDetailPanel` replaces `DayDetailPanel`; covers all 12 channels (QVC, ShopCh, 8 OA) in a single list per selected date.
- 時間順 section (QVC + ShopCh, sorted by start_time) + OA section (grouped by channel).
- Channel chip = 13 buttons (`全て` + 12 channels) with per-channel counts.
- Category chip whitelist auto-narrows to the active channel (hidden entirely when an OA channel is selected since OA has no whitelist).
- `HistoricalBroadcasts` repurposed as date-independent search panel below the calendar.
- `DayDetailPanel` removed.

## Test plan
- [ ] Pick a date with mixed channels — both sections render with correct counts.
- [ ] Select an OA channel chip — category chips disappear.
- [ ] Select a QVC chip — only QVC whitelist (7 chips) shown.
- [ ] Bottom panel empty until a search term is entered.
- [ ] Mobile: stacked layout, no sticky clipping.
EOF
)"
```

- [ ] **Step 3: Merge**

```bash
gh pr merge --merge
```

---

## Self-Review

- **Spec coverage**: every section of the spec maps to at least one task — channel-style extraction (T1), OA row presenter (T2), unified panel (T3), parent swap (T4), HistoricalBroadcasts refactor (T5), SSR page (T6), i18n (T7), cleanup (T8), docs (T9), shipping (T10).
- **Placeholders**: none. Every code block is concrete; every command is exact.
- **Type consistency**: `BroadcastChannelSlug` defined in T1 is used by T2 (`OARow.channel: string` accepts any but `CHANNEL_BADGE[row.channel as keyof typeof CHANNEL_BADGE]` does the narrowing) and T3 (channel chip palette lookup). `OARow` from T2 is imported by T3. `Broadcast` from `BroadcastListItem` (already exists in the codebase, augmented with `category` in PR #43) is consumed by T3.
- **Convention checks**: no `getServiceClient` in user-initiated paths (T3 uses fetch; T4/T6 keep existing `auth.sb` usage via T6's edits not introducing any new client). PR #43's `Cache-Control: private` + RLS-respecting client untouched.
- **Out of scope reminders honored**: no new API endpoint, no new DB column, no test framework changes.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-unified-day-detail-panel.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task + review checkpoints.
2. **Inline Execution** — execute tasks in this session using executing-plans.

Which approach?
