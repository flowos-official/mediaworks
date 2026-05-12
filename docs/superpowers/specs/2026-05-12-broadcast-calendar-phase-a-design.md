# Broadcast Calendar — Phase A Design

**Status**: Approved (brainstorm complete, ready for implementation plan)
**Date**: 2026-05-12
**Scope**: Phase A only — passive read-only calendar of past broadcasts from two Japanese home shopping channels. Phases B (product research integration) and C (analytics) tracked as future roadmap.

---

## 1. Goal

Provide an internal calendar view that shows past broadcasts from **Shop Channel** (`shopch.jp`) and **QVC Japan** (`qvc.jp`), refreshed daily. Operators can look up "what aired yesterday / last week" at a glance, filter by channel, and click through to the original broadcast page.

**Out of scope for Phase A**: products inside each broadcast, click-through to the existing `/api/analyze` research pipeline, time-slot pattern analytics, push notifications, alerts.

## 2. Roadmap

| Phase | Scope | Status |
|---|---|---|
| **A** (this doc) | Passive calendar with date, time, channel, title, presenter, description, thumbnail, source URL | **In design — ready to plan** |
| B | Per-broadcast product extraction; click broadcast → product list → trigger existing research pipeline | Future spec |
| C | Time-slot/category/presenter analytics; integrate with existing `app/[locale]/analytics` page | Future spec |

Phase A's `broadcasts` table is the foundation. B adds `broadcast_products` (no schema migration to `broadcasts`). C adds views/aggregations on top.

## 3. Sources & Data Surface

Both sites serve **server-rendered HTML** — `cheerio` is sufficient, no headless browser.

| Channel | URL Pattern | Notes |
|---|---|---|
| Shop Channel | `https://www.shopch.jp/pc/tv/programlist?onAirDay={YYYYMMDD}` | Grouped by morning/afternoon, ~30–60 slots/day |
| QVC Japan | `https://qvc.jp/content/programguide.qvc.{YYYYMMDD}0000.html` | 24 hourly sections, navigator photo + brief description |

**Lookback**: 7-day backfill at launch + forward-going daily cron. Today's date is 2026-05-12; first cron after launch handles 2026-05-11.

## 4. Architecture

```
Vercel Functions
├─ GET /api/cron/daily-broadcasts            (16:00 UTC daily)
├─ POST /api/broadcasts/refresh              (admin / recovery)
└─ GET /api/broadcasts?from&to&channel       (calendar page read API)
                  │
                  ▼
       lib/broadcasts/
         types.ts     fetch.ts
         shopch.ts    qvc.ts
         persist.ts   index.ts (scrapeAllForDate)
                  │
                  ▼
       Supabase: broadcasts table

Next.js App Router (client)
└─ app/[locale]/broadcasts/page.tsx
   └─ components/broadcasts/
      BroadcastCalendar.tsx  (state hub)
      ├─ MonthGrid.tsx
      │  └─ DateCell.tsx
      └─ DayDetailPanel.tsx
         ├─ ChannelFilter.tsx
         └─ BroadcastListItem.tsx + ChannelBadge.tsx
```

### Data flow

**Write**: Vercel cron (or manual trigger) → `scrapeAllForDate(date)` → two parsers run in parallel → `upsertBroadcasts()` to Supabase.

**Read**: page.tsx (Server Component) fetches initial month → `BroadcastCalendar` (Client) caches per month → user navigates dates/filters in-memory.

## 5. Data Model

**Migration**: `supabase/migrations/2026-05-12_broadcasts_calendar.sql`

```sql
DO $$ BEGIN
  CREATE TYPE broadcast_channel AS ENUM ('shopch', 'qvc');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         broadcast_channel NOT NULL,
  air_date        date NOT NULL,               -- JST broadcast day
  start_time      time NOT NULL,               -- JST start time HH:MM:SS
  program_title   text NOT NULL,
  presenter       text,
  description     text,
  thumbnail_url   text,                        -- external hotlink (Phase A)
  source_url      text NOT NULL,
  scraped_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcasts_slot_unique UNIQUE (channel, air_date, start_time)
);

CREATE INDEX IF NOT EXISTS broadcasts_air_date_idx
  ON broadcasts (air_date DESC);
CREATE INDEX IF NOT EXISTS broadcasts_channel_date_idx
  ON broadcasts (channel, air_date DESC);

CREATE OR REPLACE FUNCTION broadcasts_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS broadcasts_updated_at_trg ON broadcasts;
CREATE TRIGGER broadcasts_updated_at_trg
  BEFORE UPDATE ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION broadcasts_set_updated_at();
```

### Decisions

- **UUID PK** + `gen_random_uuid()` — matches `discovery_sessions` etc.
- **`channel` enum** — adding channels in Phase B uses `ALTER TYPE ADD VALUE`.
- **`air_date` + `start_time` separate** (not TIMESTAMPTZ) — broadcasts are inherently JST; no timezone-conversion confusion.
- **No `end_time`** — derivable from next slot; storing it doubles writes for no gain.
- **`(channel, air_date, start_time)` unique** — enables idempotent upsert; cron re-runs are safe.
- **`air_date DESC` index** — common pattern is "most recent first".
- **No RLS** — project convention (server uses service role; clients go via API routes).

### Volume estimate

~60–120 slots/day × 2 channels → ~22,000–44,000 rows/year. Postgres handles this trivially.

## 6. Scrapers (`lib/broadcasts/`)

### Module layout

```
lib/broadcasts/
  types.ts        ScrapedSlot, BroadcastChannel, ScrapeResult
  fetch.ts        polite HTTP fetcher (UA, timeout, retry)
  shopch.ts       scrapeShopChannelForDate(date): Promise<ScrapeResult>
  qvc.ts          scrapeQVCForDate(date): Promise<ScrapeResult>
  persist.ts      upsertBroadcasts(slots): {inserted, updated, errors}
  index.ts        scrapeAllForDate(date) — parallel both channels + persist
```

### Types

```ts
export type BroadcastChannel = 'shopch' | 'qvc';

export interface ScrapedSlot {
  channel: BroadcastChannel;
  air_date: string;        // YYYY-MM-DD (JST)
  start_time: string;      // HH:MM:SS (JST)
  program_title: string;
  presenter: string | null;
  description: string | null;
  thumbnail_url: string | null;
  source_url: string;
}

export interface ScrapeResult {
  channel: BroadcastChannel;
  date: string;
  slots: ScrapedSlot[];
  ok: boolean;
  error?: string;
  health: {
    expectedNonZero: boolean;
    actualCount: number;
    fieldCoverage: { presenter: number; description: number; thumbnail_url: number };
  };
}
```

### Fetcher (`fetch.ts`)

- User-Agent identifies the operator: `MediaWorks-Broadcast-Calendar/1.0 (+contact@mediaw-b.com)`
- Timeout 15s; 1 retry on network errors only (4xx not retried)
- Caller (backfill script) sleeps 1s between requests

### Parsers — responsibilities

Each `scrape*ForDate(date)` returns a `ScrapeResult`. Exact CSS selectors are decided during implementation against live HTML; the spec only fixes the **extraction contract**:

- **Shop Channel**: walk morning/afternoon sections → per slot extract start time, program title, optional presenter, optional one-line description, optional thumbnail `<img src>`.
- **QVC Japan**: walk 24 hourly sections → per section extract start time, show title, navigator name, brief description, thumbnail.
- "No data" text → return empty `slots` with `ok: true` (not an error).

### Persistence (`persist.ts`)

- `upsert(slots, { onConflict: 'channel,air_date,start_time' })`
- Returns per-call `{inserted, updated, errors}` — errors are per-row, do not fail the batch

### Composition (`index.ts`)

```ts
scrapeAllForDate(date: Date): Promise<{
  results: ScrapeResult[];
  totalInserted: number;
  totalUpdated: number;
}>
```

Runs both channel parsers in parallel (independent sites), persists each result as soon as it arrives.

### New dependency

```json
"cheerio": "^1.0.0"
```

## 7. API Routes

### `GET /api/broadcasts` (public read)

| Param | Type | Required | Notes |
|---|---|---|---|
| `from` | YYYY-MM-DD | yes | JST start (inclusive) |
| `to` | YYYY-MM-DD | yes | JST end (inclusive) |
| `channel` | `shopch` \| `qvc` | no | Omit to include both |

**Validation**: 400 on malformed dates, range > 62 days, or `to < from`.

**Response**:
```json
{ "broadcasts": [ ScrapedSlot... ], "total": 432 }
```

Sorted by `air_date ASC, start_time ASC, channel ASC`. No pagination (62 × ~120 ≈ 7,500 rows max — single response acceptable).

**Caching**: `Cache-Control: public, max-age=300, stale-while-revalidate=3600`.

### `POST /api/broadcasts/refresh` (admin / recovery)

**Auth**: `Authorization: Bearer ${CRON_SECRET}` (matches `discovery/manual-trigger` pattern).

**Body**: `{date: 'YYYY-MM-DD'}` or `{from, to}` (max 7 days).

**Behavior**: For each date in range, call `scrapeAllForDate(d)` sequentially with 1s sleep between dates.

**Response**:
```json
{
  "ok": true,
  "results": [{ "date": "2026-05-11", "shopch": {...}, "qvc": {...} }],
  "totals": { "inserted": 82, "updated": 0, "errors": 0 }
}
```

`maxDuration: 60`.

### `GET /api/cron/daily-broadcasts` (Vercel cron)

**Schedule**: `0 16 * * *` UTC (= 01:00 JST — right after the broadcast day ends in Japan).

**Auth**: `verifyCronAuth(req)` against `CRON_SECRET` (matches `daily-discovery-home` pattern).

**Behavior**:
1. Compute "yesterday in JST" relative to UTC now.
2. Call `scrapeAllForDate(yesterdayJst)`.
3. Emit summary log line:
   ```
   {"event":"broadcasts.scrape.summary","date":"...","channels":{...},"durationMs":...}
   ```

`maxDuration: 60`.

### `vercel.json` additions

```json
{
  "functions": {
    "app/api/cron/daily-broadcasts/route.ts": { "maxDuration": 60 },
    "app/api/broadcasts/refresh/route.ts":    { "maxDuration": 60 }
  },
  "crons": [
    { "path": "/api/cron/daily-broadcasts", "schedule": "0 16 * * *" }
  ]
}
```

16:00 UTC slot is unused by existing crons (22:45/23:00/23:30 UTC, 09:00 UTC, 01:00 UTC Mon).

### One-shot backfill script

**File**: `scripts/backfill-broadcasts.ts` — sequentially fetches N days back (default 7), 1s sleep between dates, uses Supabase service role from `.env.local`.

**`package.json`**:
```json
"backfill:broadcasts": "tsx --env-file=.env.local scripts/backfill-broadcasts.ts"
```

Used once at launch; lives under `scripts/` (project convention for one-off tools).

## 8. UI

### Routes

- `/[locale]/broadcasts` — main page (Server Component shell, Client interaction)
- i18n locales `ja` (default) and `en`. Broadcast content stays in Japanese; only UI shell is translated.

### Component tree

```
app/[locale]/broadcasts/
  page.tsx                       Server: fetch initial month, render shell
  loading.tsx                    Skeleton grid

components/broadcasts/
  BroadcastCalendar.tsx          'use client' — state hub
  MonthGrid.tsx                  pure presentation
  DateCell.tsx                   single cell with date + per-channel mini-chip
  DayDetailPanel.tsx             time-sorted unified list for selected date
  ChannelFilter.tsx              pills: All / Shop CH / QVC
  BroadcastListItem.tsx          one card per slot
  ChannelBadge.tsx               reusable colored pill (Shop CH=red, QVC=violet)
```

### URL state

```
/ja/broadcasts                            today's month, today selected
/ja/broadcasts?date=2026-05-11            month of date, that date selected
/ja/broadcasts?date=2026-05-11&ch=qvc     + QVC-only filter
```

`useSearchParams` + `router.replace` (scroll preserved). Bookmarkable and refresh-safe.

### State machine

```
mount:
  selectedMonth ← month of (URL date || today)
  selectedDate  ← URL date || today
  channelFilter ← URL ch || 'all'

month nav (←/→):
  selectedMonth ← prev/next, selectedDate ← null
  fetch new month if not cached

date click:
  selectedDate ← clicked
  URL ← ?date=...&ch=...

filter change:
  channelFilter ← new
  URL ← ?date=...&ch=...
```

### Layout

- **Desktop**: month grid (left, `grid-cols-7`) + day detail panel (right). Same viewport, no modal.
- **Mobile (< 768px)**: vertical stack — grid on top, panel below; smooth scroll-to-panel on date click.

### Day detail card

```
┌────────────────────────────────────────┐
│ 00:00  [Shop CH]                       │
│ 美容コスメ特集                          │
│ ナビ: 田中 / 説明: ...                  │
│ [thumbnail 64×48 or placeholder]       │
│                            🔗 原本を見る │
└────────────────────────────────────────┘
```

`source_url` opens in a new tab. Card body click is reserved for Phase B drill-down.

### i18n additions

`messages/{ja,en}.json` gain a `broadcasts` namespace:
- `title`, `channels.{shopch,qvc}`, `filters.{all,shopch,qvc}`, `broadcastCount`, `empty.*`, `openSource`

`nav` namespace gets a new `broadcasts` key. `components/Navbar.tsx` adds the link with `Calendar` icon from lucide-react.

### Empty / error states

| Situation | Message |
|---|---|
| Pre-first-cron (0 total) | "📺 まだ番組情報がありません。明日のJST 01:00以降にデータが入ります。" |
| Date has no data | "この日の番組情報はまだ収集されていません。" |
| Filter yields 0 | "このチャネルの番組はありません。フィルターを変更してください。" |
| API error | "番組情報の取得に失敗しました。" + retry button |

## 9. Error Handling & Resilience

| Layer | Failure | Policy |
|---|---|---|
| HTTP fetch | 5xx / timeout / network | 1 retry → empty result + error log |
| HTTP fetch | 4xx (incl. 404) | No retry, empty result |
| Parse | 0 slots returned | Warn log (markup-change suspect) — no DB write |
| Parse | optional field missing | Store as null |
| Parse | required field missing | Skip that slot, increment error count |
| DB upsert | unique conflict | Absorbed by upsert (normal) |
| DB upsert | other error | Per-row error collected; batch continues |
| Channel-level | shopch or qvc throws | Other channel still runs |
| Cron timeout (60s) | both channels stalled | Next day's cron handles next day only; older days need manual `refresh` |

### Principles

1. **Partial failure is normal** — one slot's parse error never kills the cron.
2. **Empty result ≠ error** — health signal distinguishes "truly empty day" from "parser broke".
3. **DB is monotonically additive** — scrapers only `upsert`, never `delete`. Failures cannot destroy historical data.
4. **Idempotent** — same date scraped N times yields the same DB state.

### Markup-change detection

Each `ScrapeResult` carries `health.{expectedNonZero, actualCount, fieldCoverage}`. When `expectedNonZero && actualCount === 0`, log:

```
WARN: shopch returned 0 slots for 2026-05-11 — markup change suspected?
```

Vercel function logs are the only sink in Phase A. Sentry/Logflare is a Phase B+ consideration if monitoring value grows.

### Politeness toward target sites

- 1 request per site per scrape; cron does both channels in parallel (1 req each, no flood)
- Backfill sleeps 1s between dates
- User-Agent identifies operator + contact
- Cron at 16:00 UTC = JST 01:00 (low-traffic window for the sites)
- Refresh API capped at 7-day range — larger backfills go through the one-shot script

### Explicitly out of scope (YAGNI)

- ❌ Slack/email alerts
- ❌ Distributed locks (Vercel cron is single-fire; upsert is idempotent)
- ❌ Automatic selector recovery via AI
- ❌ Fallback channel sources

## 10. Testing Strategy

The project has **no test framework** (no Jest/Vitest). Convention is `scripts/test-*.ts` tsx scripts invoked via `npm run test:*`. This spec follows that.

### Parser regression (fixture-based)

```
scripts/
  test-broadcasts-shopch-parser.ts
  test-broadcasts-qvc-parser.ts
  fixtures/broadcasts/
    shopch-20260511.html
    qvc-20260511.html
    shopch-20260511.expected.json
    qvc-20260511.expected.json
```

Each test loads HTML fixture → runs parser → asserts:
- slot count within expected range (e.g., 20–80)
- first slot has all required fields filled
- nullable field coverage above thresholds (presenter ≥ 70%, description ≥ 80%)
- start times normalized to `HH:MM:SS` and sortable

**Fixture refresh**: when site markup changes, capture new HTML + update expected.json + commit.

```json
"test:broadcasts-parsers": "tsx --env-file=.env.local scripts/test-broadcasts-shopch-parser.ts && tsx --env-file=.env.local scripts/test-broadcasts-qvc-parser.ts"
```

### Live integration (manual)

`scripts/test-broadcasts-scrape-live.ts` — hits real sites for yesterday, asserts both channels return ≥ 1 slot. No DB write. Run before major releases.

```json
"test:broadcasts-live": "tsx --env-file=.env.local scripts/test-broadcasts-scrape-live.ts"
```

### Operational diagnostics

`scripts/verify-broadcasts-run.ts` (mirrors `scripts/verify-discovery-run.ts` pattern) — queries DB for:
- counts for yesterday/today
- rows with `scraped_at` in last 24h
- per-channel slot distribution
- nullable field coverage stats

```json
"verify:broadcasts": "tsx --env-file=.env.local scripts/verify-broadcasts-run.ts"
```

### Manual UI checklist

- [ ] `/ja/broadcasts` renders calendar
- [ ] Month ←/→ navigation works
- [ ] Date click updates detail panel and URL `?date=...`
- [ ] Channel filter updates list and URL `?ch=...`
- [ ] Fresh tab with full URL reproduces state
- [ ] Empty date shows "not collected" message
- [ ] Mobile (375px) stacks vertically
- [ ] `/en/broadcasts` shows English shell, Japanese content
- [ ] Navbar link active state correct
- [ ] "原本を見る" opens `source_url` in new tab

### Definition of Done

1. `npm run lint` passes
2. `npm run build` succeeds
3. `npm run test:broadcasts-parsers` passes
4. `npm run test:broadcasts-live` runs once and returns ≥ 1 slot/channel
5. `npm run backfill:broadcasts -- --days=7` populates ≥ 50 rows locally
6. All UI checklist items pass
7. `vercel.json` cron registered; Vercel dashboard shows the cron entry

## 11. File Inventory (new + modified)

### New files

| Path | Purpose |
|---|---|
| `supabase/migrations/2026-05-12_broadcasts_calendar.sql` | Schema |
| `lib/broadcasts/types.ts` | Types |
| `lib/broadcasts/fetch.ts` | Polite HTTP fetcher |
| `lib/broadcasts/shopch.ts` | Shop Channel parser |
| `lib/broadcasts/qvc.ts` | QVC parser |
| `lib/broadcasts/persist.ts` | Supabase upsert |
| `lib/broadcasts/index.ts` | `scrapeAllForDate` composition |
| `app/api/broadcasts/route.ts` | GET list |
| `app/api/broadcasts/refresh/route.ts` | POST manual trigger |
| `app/api/cron/daily-broadcasts/route.ts` | Daily cron |
| `app/[locale]/broadcasts/page.tsx` | Page |
| `app/[locale]/broadcasts/loading.tsx` | Skeleton |
| `components/broadcasts/BroadcastCalendar.tsx` | State hub |
| `components/broadcasts/MonthGrid.tsx` | Grid |
| `components/broadcasts/DateCell.tsx` | Cell |
| `components/broadcasts/DayDetailPanel.tsx` | Detail list |
| `components/broadcasts/ChannelFilter.tsx` | Filter pills |
| `components/broadcasts/BroadcastListItem.tsx` | List card |
| `components/broadcasts/ChannelBadge.tsx` | Badge |
| `scripts/backfill-broadcasts.ts` | One-shot 7-day backfill |
| `scripts/test-broadcasts-shopch-parser.ts` | Parser test |
| `scripts/test-broadcasts-qvc-parser.ts` | Parser test |
| `scripts/test-broadcasts-scrape-live.ts` | Live integration test |
| `scripts/verify-broadcasts-run.ts` | Operational diagnostic |
| `scripts/fixtures/broadcasts/*.html` + `*.expected.json` | Parser fixtures |

### Modified files

| Path | Change |
|---|---|
| `package.json` | + `cheerio` dep; + 4 `test:`/`verify:`/`backfill:` scripts |
| `vercel.json` | + function `maxDuration` for cron; + cron entry |
| `components/Navbar.tsx` | + broadcasts link |
| `messages/ja.json`, `messages/en.json` | + `broadcasts` namespace; + `nav.broadcasts` |
| `CLAUDE.md` | + section noting the broadcast calendar feature and its cron |

## 12. Open Questions (Resolved Before Implementation)

| # | Question | Decision |
|---|---|---|
| 1 | Which two channels? | Shop Channel + QVC Japan (after replacing initial `mediaw-b.com`) |
| 2 | How far back to seed? | 7-day backfill at launch, daily forward |
| 3 | Fields per slot? | 8 fields: date, time, channel, title, presenter, description, thumbnail, source URL |
| 4 | Thumbnails — store or hotlink? | **Hotlink** in Phase A; revisit when Phase B introduces S3 product images |
| 5 | Refresh cadence? | Daily 16:00 UTC cron + admin `POST /refresh` for recovery |
| 6 | Calendar layout? | Month grid + click date → time-sorted unified list with channel badges + filter (Layout B from brainstorm mockups) |
| 7 | Auth on read API? | None (public read) |
| 8 | Auth on refresh / cron? | `CRON_SECRET` Bearer (project convention) |

## 13. Acceptance Criteria

- Calendar page available at `/ja/broadcasts` and `/en/broadcasts`
- After launch backfill: at least 7 days × 2 channels visible
- Daily cron runs at 16:00 UTC and adds yesterday's data automatically
- Manual `POST /api/broadcasts/refresh` recovers any specific date
- Markup change in either site produces a `WARN` log but does not corrupt existing data
- Phase B (product extraction) can be built without modifying the `broadcasts` table
