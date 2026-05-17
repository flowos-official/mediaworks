# Unified Day Detail Panel — Design Spec

**Date:** 2026-05-17
**Status:** Approved (pending user spec review)

## Goal

Consolidate the two separate broadcast lists on `/[locale]/broadcasts` (the right-side `DayDetailPanel` showing QVC + ShopCh slots, and the bottom `HistoricalBroadcasts` showing the 8 OA channels) into a single per-day view, while preserving free-text history search as a clearly separated lower section.

## User-Facing Outcome

On any selected calendar date, the user sees **one list of every channel's broadcasts that day** — QVC, Shop Channel, and the 8 OA channels (japanet, junsanpo, ntv, tbs, dinos, senobura, uranoura, btops). Filtering by channel or category works across all 12 channels in one place. The free-text "search across all history" capability that used to live in the bottom panel is preserved but is no longer date-coupled — it becomes its own search tool below the calendar.

## Architecture

### Two distinct UI regions

1. **Calendar + side panel (top)** — "show me today"
   - Left: month grid (`MonthGrid`, unchanged).
   - Right: **new `UnifiedDayDetailPanel`** (sticky scrollable) — one list for the selected date covering all 12 channels.
2. **History search (bottom)** — "find a product across the archive"
   - Repurposed `HistoricalBroadcasts` — no longer coupled to `selectedDate`. Empty by default, populates when the user types a search term and submits. Channel chips and pagination preserved.

The two regions never reference each other's state. The calendar drives the top panel only; the search bar drives the bottom panel only.

### Data flow — top panel (UnifiedDayDetailPanel)

When the selected date changes, the panel fetches in parallel:

```
Promise.all([
  fetch(`/api/broadcasts?from=YYYY-MM-DD&to=YYYY-MM-DD`)        // QVC + ShopCh
  fetch(`/api/historical-broadcasts?date=YYYY-MM-DD&limit=500`) // 8 OA channels
])
```

No new API endpoint. Both routes already enforce `requireUser` + RLS-respecting `auth.sb` (per PR #43). The single calendar's month-bounded broadcasts cache (already in `BroadcastCalendar`) is reused for the day filter so the QVC/ShopCh fetch is normally a cache hit; the OA fetch is per-day.

The merged dataset is partitioned client-side into:

- `timedRows`: `broadcasts` rows (QVC + ShopCh) — have `start_time`.
- `oaRows`: `historical_broadcasts` rows (8 OA channels) — no `start_time`.

### Data flow — bottom panel (HistoricalBroadcasts, repurposed)

Same `/api/historical-broadcasts` endpoint, called with `search` query param (not `date`). Channel and category params behave as today. Pagination is unchanged. The component no longer subscribes to `urlDate`; SSR initial state is "empty / waiting for search".

## Component Inventory

### New

- `components/broadcasts/UnifiedDayDetailPanel.tsx` — replaces `DayDetailPanel` in the right column. Receives `date`, channel/category filter state, and the merged data. Renders channel + category chip rows, a timed-section, and an OA-section.
- `components/broadcasts/OABroadcastListItem.tsx` — row presenter for an OA row (channel badge, product_name, optional price). Mirrors `BroadcastListItem` styling.

### Modified

- `components/broadcasts/BroadcastCalendar.tsx` — passes the OA fetch + merged data to `UnifiedDayDetailPanel` (replaces the current `DayDetailPanel` import). All other calendar/grid logic unchanged.
- `components/broadcasts/HistoricalBroadcasts.tsx` — `urlDate` removed from the props/effect chain. `initialDate` prop dropped. Search becomes the primary mode; empty state when no search term.
- `app/[locale]/broadcasts/page.tsx` — SSR no longer initializes the historical list with the selected date's rows (initial state is empty/0). The component still SSR-mounts so the user can immediately type a search term.

### Removed (or kept dormant)

- `components/broadcasts/DayDetailPanel.tsx` — no consumers remain; delete the file.

## UI Specifications

### Layout (md+ width)

```
+--------------------------------+---------------------------------+
|  < 2026年5月 >                 | 2026年5月10日 (月) — 28件         |
|  Mo Tu We Th Fr Sa Su          | [全て] [QVC (4)] [ShopCh (5)] +8|
|   1  2  3  4  5  6  7          | [全カテゴリ][ビューティー]...      |
|   8  9 (10) 11 12 13 14        |                                 |
|  15 16 17 18 19 20 21          | ─ 時間順 ──────────────────     |
|  22 23 24 25 26 27 28          | 10:00 [QVC]    ボツワナ...       |
|  29 30 31                      | 11:00 [ShopCh] ロンドン...       |
|                                | 13:00 [ShopCh] エコ...          |
|                                |                                 |
|                                | ─ OA チャネル (時間情報なし) ──   |
|                                | [ntv]    フィットネス  ¥18,800   |
|                                | [tbs]    マッサージ   ¥9,980    |
|                                | ...                             |
+--------------------------------+---------------------------------+
|                                                                  |
|  ─── 全履歴検索 (8 OA channels) ─────────────────                 |
|  [search box ___________] [search]                               |
|  Channel chips: [全て] [japanet] [ntv] [tbs] ...                 |
|  (Empty until a search term is entered.)                         |
+------------------------------------------------------------------+
```

### Channel chips (top panel)

- Order: `全て`, `QVC`, `ShopCh`, then OA in the existing OA component's order (japanet, junsanpo, ntv, tbs, dinos, senobura, uranoura, btops).
- `(N)` count rendered next to each chip — derived from the merged dataset client-side after applying the category filter (so a category-narrowed view still shows per-channel counts that match the visible list).
- `flex flex-wrap` — wraps to 2 lines naturally at common widths.
- Color coding: QVC and ShopCh reuse the existing `ChannelBadge` palette. OA channels reuse the `CHANNEL_BADGE` map already defined in `HistoricalBroadcasts.tsx` (extract to a shared `lib/broadcasts/channel-style.ts` if needed).

### Category chips (top panel)

- Visibility:
  - `channelFilter === "all"` → union of QVC + ShopCh whitelist (12 chips dedup → 11).
  - `channelFilter === "qvc"` → 7 QVC chips.
  - `channelFilter === "shopch"` → 5 ShopCh chips.
  - `channelFilter` is an OA channel → **hidden entirely** (OA has no whitelist; chips would be meaningless).
- Filtering policy unchanged (PR #47):
  - `全カテゴリ` = no filter (every row, including `category === null`).
  - Specific chip = `b.category === chip`.

### Section rendering

- **時間順 section**: rendered only if `timedRows.length > 0`. Sorted by `start_time` ascending; secondary sort by `channel`. Each row uses the existing `BroadcastListItem`.
- **OA チャネル section**: rendered only if `oaRows.length > 0`. Rows grouped by `channel` (channels keep their existing OA order). Each row uses the new `OABroadcastListItem` which renders channel badge → product_name → price.
- Section headers are simple `─ <name> ─` text dividers (no fancy disclosure UX). Each header includes `(N件)` after the name.

### Empty states

- Both `timedRows` and `oaRows` empty: single message in the panel: `この日の番組情報はまだ収集されていません`.
- Filter narrows result to zero: `フィルター結果がありません。フィルターを変更してください。`
- One section empty, the other has rows: render the non-empty section only; the empty section is hidden (no `(0件)` placeholder header).

### Bottom panel (history search)

- Heading: `全履歴検索` (ja) / `전체 이력 검색` (ko). Subtitle removed (or updated to "키워드로 8 채널 전체 OA 데이터 검색").
- Initial empty state: `検索ワードを入力してください` / `검색어를 입력해주세요`.
- Search submit, channel chip, pagination — all preserved from current behavior.
- The `urlDate` effect and `initialDate` prop are removed.

### Sticky / scroll

- The wrapper applied in PR #49 is preserved: `md:max-h-[calc(100vh-12rem)] md:overflow-y-auto md:sticky md:top-4 pr-1` on the right column.

## Error Handling

- Either API call failing → render that section's empty state with a small `(取得失敗)` annotation in the section header; do not block the other section.
- Network errors are swallowed into the panel — no global toast / alert. Consistent with current behavior.

## Migration Path

1. New `UnifiedDayDetailPanel` + `OABroadcastListItem` files.
2. `BroadcastCalendar` updated to import + render the new panel.
3. `HistoricalBroadcasts` modified to drop date coupling.
4. `page.tsx` SSR adjusted: drop the historical "selected date" fetch — initial historical is empty.
5. `DayDetailPanel.tsx` deleted.
6. `CLAUDE.md` updated to reflect the unified layout.

No DB schema changes. No env var changes. No new API endpoints.

## Test Plan

- [ ] Visit `/ja/broadcasts`, pick a date with mixed-channel slots — both `時間順` and `OA チャネル` sections appear with correct row counts.
- [ ] Channel chip `(N)` counts equal the visible row counts after category filter applied.
- [ ] Select QVC chip → カテゴリ chips narrow to 7. Select ntv chip → カテゴリ chips disappear.
- [ ] Pick a date with zero OA but populated QVC — only the timed section renders.
- [ ] Pick a date with zero data entirely — friendly empty message renders.
- [ ] Bottom panel: enter search term → fetches across all dates. Clear search → returns to empty state.
- [ ] Calendar date click no longer affects the bottom panel.
- [ ] Mobile (single column) → top panel and bottom panel stack naturally, sticky behavior disabled.
- [ ] As `viewer` (unauthorized) → page redirects to login (PR #43 behavior preserved).
- [ ] As `member`/`admin` → all sections render with RLS-respecting client.

## Out of Scope

- New API endpoint or union view (kept to existing two routes).
- Backfill for dates where `historical_broadcasts` has no rows due to past cron gaps (separate ticket).
- Time-grid / TV guide layout (rejected during brainstorming — OA channels lack timestamps).
- Server-side merge of the two tables (kept client-side for clarity).

## Open Questions

None at this time. All decisions captured above.

---

## Self-review (post-write)

- **Placeholders**: no `TBD` / `TODO` / `(?)` markers remain.
- **Internal consistency**: `HistoricalBroadcasts` modifications described in both "Component Inventory" and "UI Specifications → Bottom panel" sections match.
- **Scope**: focused on the layout/data-flow consolidation. No new tables, no new endpoints. Implementable in one PR.
- **Ambiguity**: section dividers use plain text (`─ <name> ─`); empty-section hide rule is explicit; OA-channel-active category chip behavior is explicit (hidden).
