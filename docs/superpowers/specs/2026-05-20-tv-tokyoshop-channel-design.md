# TV Tokyo Shop (テレ東マート) Channel — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-05-20
**Scope**: Add tv-tokyoshop.jp as a new OA channel to the broadcast calendar, historical-broadcasts data set, and discovery TV-channel registry. Leverages the same parser → `historical_broadcasts` → calendar UI pipeline already used by the other 7 OA channels.

---

## 1. Goal

Surface tv-tokyoshop.jp's daily TV-shopping broadcasts on the existing `/[locale]/broadcasts` calendar and feed its products into the discovery pool — same treatment the other 7 OA channels (japanet, junsanpo, ntv, tbs, dinos, senobura, uranoura) already receive. After this change the calendar shows **10** channels (qvc + shopch + 8 OA), and the discovery TV registry has **16** channels.

## 2. Non-Goals

YAGNI carve-outs explicitly out of scope:

- **Per-slot broadcast times.** The API does not expose `ProgramBroadcastDate` (always null on the list endpoint). `start_time` stays NULL in `historical_broadcasts`, matching 6 of the 7 existing OA channels. Future re-audits can fill it without schema change.
- **Product detail enrichment** (variant skus, full description, video). The list endpoint returns enough for `historical_broadcasts` (name, gcode, price, image, detail URL). Detail fetch is a separate, optional follow-up; not blocking the calendar surface.
- **Backfill of historical data beyond today's daily cron.** The calendar's value is the rolling daily feed; one-shot backfill can be added later via `npm run backfill:broadcasts` if needed.
- **Category whitelist for the new channel.** OA channels in `historical_broadcasts` currently pass through unchanged (no whitelist applied — see CLAUDE.md). Adding txd-specific category curation is a future ops decision, not part of this spec.
- **Competitive-fit analysis / fit-weighting integration.** Those layers operate on `broadcasts` (qvc + shopch), not `historical_broadcasts`. No new wiring.
- **Video archival.** Only QVC archives video today; that path is separate from this spec.

## 3. External API Contract (verified)

Endpoint discovered by reverse-engineering the SPA's webpack bundle on 2026-05-20.

| Field | Value |
|---|---|
| Base | `https://api.tv-tokyoshop.jp/api/v1` |
| Path | `/product/SearchWithBroadcastDate` |
| Method | `GET` |
| Required header | `X-User-Key: ers_v8` (static constant in the SPA, not session-bound) |
| Query params | `BroadcastDate=YYYY/MM/DD`, `PageOffset=1`, `PageDispLimit=50`, `ProductSearchSort=1`, `device_pc_flg=1`, `device_sp_flg=0`, `device_ap_flg=0` |
| Auth state | Stateless — no session/login required. Set-Cookie headers in the response can be ignored. |
| robots.txt | Permissive for the data paths. Sensitive paths (`/admin`, `/member`, `/cart`) blocked but irrelevant here. |

### Response shape (top level)

```jsonc
{
  "RSuccess": true,
  "RCount": 15,                                          // total rows for the day across all pages
  "InputBroadcastDate": "Tue May 19 00:00:00 UTC+0900 2026",
  "Product": [/* page slice */],
  "Pager": { /* page metadata */ },
  "BroadcastDateForCalendar": [/* dates with broadcasts */]
}
```

### Product item shape

```jsonc
{
  "ID": 1873,
  "Gcode": "42920",
  "Gname": "【2枚組】ARIKI 軽やかパンツ",
  "MinPrice": 15400.0,
  "MaxPrice": 15400.0,
  "PictureCollection": { "Count": 9, "URL": ["https://www.tv-tokyoshop.jp/images/item/...jpg", "..."] },
  "IconFlgList": [8],
  "Icon2OffValue": "",
  "SoldoutFlg": null,
  "ProgramBroadcastDate": null
}
```

Product detail URL is constructed from `Gcode`: `https://www.tv-tokyoshop.jp/detail?Gcode={Gcode}` (confirmed in webpack bundle).

### Verification observed

- 2026/05/18 → `RCount: 4`, 4 products returned (light day).
- 2026/05/19 → `RCount: 15`, 15 products returned.
- Response status 200, content-type `application/json; charset=utf-8`.
- Without `X-User-Key`: 401. With wrong/missing date format: 400 with `RMessage` Japanese error. With valid params: 200.

## 4. Channel Identity

- **slug**: `txd` (matches the upstream's internal `txd-dev-ivp.ivp.co.jp` environment name in their bundled config). Three letters keeps it consistent with `qvc`/`tbs`/`ntv`.
- **Display name**: `テレ東マート` (per `BROWSER_TITLE` in the bundle).
- **Badge palette**: `bg-emerald-100 text-emerald-800 border-emerald-200` (not used by any other channel; emerald is unclaimed in `CHANNEL_BADGE`).
- **Discovery `siteQuery`**: `tv-tokyoshop.jp` (full host — no subpath, the whole site is shopping content).
- **Discovery `scraped`**: `false` — matches the 7 existing OA channels. The `scraped` flag in `tv-channels.ts` specifically means "sourced from the `broadcasts` table (qvc/shopch only)", not "sourced from any scraped table." Since txd lands in `historical_broadcasts`, not `broadcasts`, it stays in the Brave site:-search pool D for discovery. Calendar visibility is separate and driven by `historical_broadcasts` via the OA-channel UI surfaces.

## 5. Implementation Plan

Six small changes; no schema migration required.

- 5.0 Extend `politeFetch` to accept optional headers (single new opt; no behavior change for existing callers).
- 5.1–5.5 below.

### 5.1 Add the slug to type unions

- `lib/historical-crawl/types.ts::OAChannelSlug` — add `"txd"` to the union.
- `lib/broadcasts/channel-style.ts::BroadcastChannelSlug` — add `"txd"`; append `{ slug: "txd", name: "テレ東マート" }` to `OA_CHANNELS`; add badge entry.
- `lib/discovery/tv-channels.ts::TV_CHANNELS` — append `{ slug: "txd", name: "テレ東マート", siteQuery: "tv-tokyoshop.jp", scraped: false }`.

### 5.2 New parser `lib/historical-crawl/parsers/txd.ts`

Mirrors `japanet.ts` structurally (`fetchToday(jstDate) → HistoricalRow[]`) but calls JSON instead of cheerio. Single file, ~60 lines:

1. Format `jstDate` (YYYY-MM-DD) → `YYYY/MM/DD` for the API.
2. Loop `PageOffset` from 1 upward, requesting `PageDispLimit: 50` each page, until accumulated `Product[]` length ≥ `RCount` from the first page (or a hard cap of 5 pages = 250 items, defensive).
3. Map each `Product` → `HistoricalRow`:
   - `channel: "txd"`
   - `air_date`: `jstDate`
   - `day_of_week`: `dayOfWeekJp(jstDate)`
   - `start_time`: `null` (API doesn't expose it)
   - `product_name`: `Gname` (truncate to 500 chars defensively)
   - `price_text`: `¥${MinPrice}` if Min == Max, else `¥${MinPrice}〜¥${MaxPrice}`
   - `price_jpy`: `MinPrice` (integer-coerced)
   - `price_is_tax_incl`: `true` (Japanese consumer-facing prices are tax-inclusive by Showhin Hyoji Hou; confirm on detail page during implementation if uncertain)
   - `source_url`: `https://www.tv-tokyoshop.jp/detail?Gcode=${Gcode}`
   - `source_sheet`: `"live-crawl:txd"`
4. Use `politeFetch` for `User-Agent`, timeout, and retry consistency with the other parsers. The current `politeFetch` hardcodes `Accept: text/html,application/xhtml+xml` and accepts no custom headers — extend it with an optional `headers?: Record<string, string>` opt that, when present, **merges** with the defaults (UA stays from `USER_AGENT`; the parser overrides `Accept` to `application/json, text/plain, */*` and adds `X-User-Key: ers_v8`). One small change to `lib/historical-crawl/fetch.ts`, no behavioral change for the 7 existing parsers since they pass no headers.

### 5.3 Register the parser

`lib/historical-crawl/index.ts::ALL_PARSERS` — append `txdParser`. No other change to `crawlAll` needed; failure isolation and `historical_crawl_runs` observability are already wired.

### 5.4 Tests

- **Parser unit test** (`tests/historical-crawl/txd.test.ts`, matching existing pattern): one recorded JSON fixture (the 2026/05/19 response), assert ≥1 row, name/price/source_url shape.
- **Live integration**: append a `txd` case to `npm run test:broadcasts-live` so failures (e.g., upstream contract change) surface in the existing diagnostic. Cron failures already surface in the `/admin/historical-crawl` dashboard via `historical_crawl_runs`.

### 5.5 UI verification (no code change expected)

`UnifiedDayDetailPanel`, `HistoricalBroadcasts`, and channel-chip filters iterate over `ALL_CHANNELS`. After the registry update, txd should appear in:

- Calendar day-detail panel (when the day has txd rows).
- Historical search panel channel chip list.
- Admin crawl observability dashboard.

If any of these surfaces hard-codes a channel list elsewhere, the implementation plan will catch it via grep for existing slugs.

## 6. Edge Cases & Failure Modes

| Scenario | Behavior |
|---|---|
| `X-User-Key` rejected (upstream rotates the constant) | 401 → parser returns []; `historical_crawl_runs` shows `rowCount=0`; admin dashboard amber/red based on 7-day median. Manual intervention: probe bundle for new key, update the constant. |
| Date with 0 broadcasts | 200 with `RCount: 0`, empty `Product[]`. Parser returns []. Normal. |
| Pagination boundary (51+ items on a single day) | Loop fetches page 2; defensive cap at 5 pages prevents runaway. |
| Upstream HTML/SPA refactor | Static API endpoint unaffected; `api.tv-tokyoshop.jp/api/v1` is a separate host with its own deployment cycle. |
| API returns malformed JSON | `politeFetch` / `fetch` error → caught in `crawlAll`'s `Promise.allSettled`; failure recorded for txd only, other parsers unaffected. |
| Duplicate row across days (same product aired multiple days) | `historical_broadcasts` UNIQUE(channel, air_date, product_name) handles natural idempotency. Reruns of the cron are safe. |
| `MinPrice > MaxPrice` (impossible per spec, defensive) | `price_text` falls back to `¥${MinPrice}`. Never blocks ingest. |

## 7. Risks

1. **`X-User-Key: ers_v8` is undocumented.** It's a constant in the SPA's `AJAX_CONFIG_DEFAULT.headers` — not an authentication token. Risk of rotation exists, but the platform appears stable (ERS commerce platform, `v8` suggests long-lived versioning). Mitigation: failure is observable, recovery is a 1-line code update.
2. **No explicit ToS reviewed.** Like the other 7 OA scrapers, this is opportunistic use of a public web endpoint. robots.txt is permissive. If TV Tokyo objects, removing the parser is a 1-line revert (`ALL_PARSERS` array). Matches the existing risk posture for OA scraping.
3. **Discovery integration via Brave site:.** Setting `scraped: false` puts txd into the Pass D Brave site:-restricted search pool alongside the other 7 OA channels (`lib/discovery/pool.ts::fetchTvChannelFromBraveSite`). This consumes `TV_CHANNEL_BRAVE_BUDGET` (default 50/day, round-robin across non-scraped channels). Adding one more channel reduces per-channel calls slightly but the budget cap protects against runaway cost. `historical_broadcasts` → discovery pool integration is documented future work in CLAUDE.md and is out of scope here.

## 8. Success Criteria

- After the daily JST 02:00 cron (`/api/cron/daily-historical-broadcasts`) runs, the calendar at `/[locale]/broadcasts` shows a "テレ東マート" chip on days that aired products, with rows appearing in `UnifiedDayDetailPanel`.
- `/admin/historical-crawl` dashboard shows a `txd` row with non-zero `rowCount` and `durationMs < 30s` on a typical day.
- `tests/historical-crawl/txd.test.ts` passes against a recorded fixture.
- `npm run test:broadcasts-live` includes a txd case that returns ≥ 1 row on a recent date.
- The historical search panel offers `テレ東マート` as a channel-chip filter and returns matching results when a known product name is typed.

## 9. Out-of-Scope Future Work

- One-shot backfill: extend `npm run backfill:broadcasts` to include txd if we want history beyond today-forward.
- Detail-page enrichment for variants (when `MinPrice ≠ MaxPrice`), broadcast description, broadcast video.
- Operator-curated category whitelist for txd (matches the current ShopCh/QVC pattern in `channel_categories`).
- Adding `tv_evidence` integration if txd's data volume warrants its own price/seasonality signal (currently the evidence layer reads `historical_broadcasts` indiscriminately, so txd participates by default — no extra wiring needed).
