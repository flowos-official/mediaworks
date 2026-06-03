# Broadcast Calendar Accuracy — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-06-02
**Scope**: Fix the broadcast calendar showing products that did NOT air on a given day, and hiding products that ARE airing. Root causes confirmed against live data on 2026-06-02. Covers QVC + Shop Channel (the two `broadcasts`-table channels).

---

## 1. Goal

Operator report (paraphrased): "Depending on the date, products that didn't air that day are shown, or products that are airing aren't shown." Also asked: are QVC/ShopCh videos stored in the cloud? (**Answer: yes** — `archive-videos` cron streams QVC + ShopCh m3u8 to AWS S3 + CloudFront; UI shows ▶ when `archived_video_s3` is set. No change needed there.)

Make the calendar's displayed slots match what actually airs:
- Show today's / future QVC slots that are currently hidden.
- Show today's / upcoming ShopCh slots (currently entirely absent).
- Stop showing forward slots that were rescheduled/cancelled upstream.
- Fix the "today" highlight to JST.

## 2. Root-Cause Investigation (evidence, 2026-06-02)

Diagnostic: `scripts/diag-calendar-accuracy.ts` (read-only) + `scripts/diag-shopch-forward.ts` (live probe). Results:

```
date        | qvc total/null-hidden | shopch total/null-hidden
2026-05-28  |  20 /  0 hidden       |  25 /  0 hidden     ← past: fine
   ...      |                       |
2026-06-02  |  20 / 17 hidden       |   0 /  0 hidden     ← JST today
2026-06-06  |  20 / 20 hidden       |   0 /  0 hidden     ← whole QVC day invisible
   ...                                                       shopch: 0 rows today+
[c] null/empty-category qvc+shopch slots hidden by UI gate: 288 / 522
```

| # | Symptom | Confirmed root cause |
|---|---|---|
| **A** | airing-but-not-shown (QVC future) | `components/broadcasts/UnifiedDayDetailPanel.tsx:57` `isWhitelistedSlot()` returns `false` when `category` is null. Category is only set after `qvc_products` enrichment (parses the product-page breadcrumb). Today/future slots arrive un-enriched → `category=null` → **hidden**. The gate conflates *unclassified (null)* with *classified-and-non-whitelist*. Past dates got enriched over time, so they display. **288/522 slots hidden.** |
| **B** | airing-but-not-shown (ShopCh today/future) | ShopCh daily cron scrapes *yesterday* only (`getYesterdayJST`); there is no forward scrape like QVC's monthly refresh. So today/upcoming ShopCh = 0 rows. **Live probe confirms `shopch.jp/pc/tv/programlist?onAirDay=<future>` DOES return that day's `data-program-id` entries (24-26/day), each request serving a 3-day window** — forward scrape is feasible by reusing `scrapeShopChannelForDate(futureDate)`. |
| **C** | shown-but-didn't-air | `lib/broadcasts/qvc-monthly.ts` (and any forward scrape) **upserts on `(channel,air_date,start_time)` but never deletes**. When QVC reschedules/cancels a forward-published slot, the stale row persists and displays as a program that won't air. Architecturally certain (upsert can't remove rows). |
| **D** | "today" off-by-one (minor) | `components/broadcasts/MonthGrid.tsx:71` `todayIso = new Date().toISOString().slice(0,10)` uses the **UTC** date. During JST 00:00-08:59 (UTC 15:00-23:59 prev day) the highlight lands on the wrong cell. |

## 3. Design

### 3.1 Fix A — fail-open the whitelist gate (decided: fail-open)

`UnifiedDayDetailPanel.tsx::isWhitelistedSlot` — null/unknown category passes through (visible); hide only when the category is *known* and not in the whitelist:

```ts
function isWhitelistedSlot(channel: string, category: string | null): boolean {
  if (channel === "qvc") return category == null || QVC_WHITELIST.has(category);
  if (channel === "shopch") return category == null || SHOPCH_WHITELIST.has(category);
  return true;
}
```

Apply the same change to `channelCount()` (lines 172-186) so chip counts match the list. **Policy note:** this intentionally relaxes the CLAUDE.md "non-whitelist hidden" rule for the *unclassified* case only — known-non-whitelist categories stay hidden. Trade-off accepted in brainstorm: a forward slot may show now and disappear once enrichment classifies it as non-whitelist. Update the CLAUDE.md broadcast-policy paragraph to record the fail-open semantics.

### 3.2 Fix B — ShopCh forward scrape (decided: include in this work)

New `lib/broadcasts/shopch-forward.ts::refreshShopChForwardRange(daysAhead = 14)`:
- Loop `offset = 0..daysAhead`, compute the JST date, call existing `scrapeShopChannelForDate(date)` (already JSON-hydrated, handles the busy-page 200 and 3-day window), collect slots.
- Upsert via existing `upsertBroadcasts` (idempotent on `(channel,air_date,start_time)`).
- Respect `politeFetch` rate limiting; ~15 requests/run. Surface per-run row counts to logs (mirror QVC monthly refresh observability).
- Wire into the JST 02:00 refresh cron (`app/api/cron/qvc-monthly-refresh/route.ts` — extend it, or add a sibling step) so ShopCh forward data refreshes daily alongside QVC.
- Env knob `SHOPCH_FORWARD_DAYS` (default 14).

### 3.3 Fix C — future-only reconciliation (footgun-safe)

After a successful forward scrape of a `(channel, date)` where `date` is **strictly future** (`air_date > today_jst`), delete `broadcasts` rows for that channel+date whose `start_time` is NOT in the freshly-scraped set.

Hard safety constraints (informed by the daily:archive footgun, memory `project-daily-archive-footgun`):
- **Only `air_date > today_jst`** (strictly future). Never touch today or past.
- Future slots inherently have **no archived video** (archival only runs on `air_date <= today`), so reconciliation cannot destroy archived footage. Add an explicit `archived_video_s3 IS NULL AND video_status NOT IN ('downloading','archived')` guard anyway as defense-in-depth.
- Only delete when the fresh scrape for that date **succeeded** (non-empty, not the busy page) — never reconcile against a failed/empty scrape, or a transient upstream error would wipe a day.
- Applies to both QVC monthly refresh and the new ShopCh forward scrape.

### 3.4 Fix D — MonthGrid JST today

Replace `new Date().toISOString().slice(0,10)` with a `getTodayJST()` helper (add to `lib/broadcasts/jst-date.ts` alongside `getYesterdayJST`). One line in `MonthGrid.tsx:71`.

## 4. Tests

- **A** — unit test on `isWhitelistedSlot`: `(qvc,null)→true`, `(qvc,"家電")→true`, `(qvc,"占い")→false`, `(shopch,null)→true`, `(ntv,null)→true`.
- **B** — `npm run test:shopch-forward` (live integration): `refreshShopChForwardRange(2)` returns rows for today+tomorrow on a normal day; tolerate the busy page as a skip, not a failure.
- **C** — reconciliation unit test with a stubbed scrape result: a stale future slot absent from the fresh set is removed; a past slot and an archived future row (defensive) are never removed; a failed/empty scrape removes nothing.
- **D** — `getTodayJST()` boundary unit test (e.g. fixed UTC instant at JST 02:00 returns the JST calendar date, not UTC's previous day).
- Promote `scripts/diag-calendar-accuracy.ts` to `npm run verify:calendar-accuracy` as an operational diagnostic. Delete the one-shot `scripts/diag-shopch-forward.ts` (its question is answered and recorded in §2).

## 5. Edge Cases & Failure Modes

| Scenario | Behavior |
|---|---|
| Enrichment later classifies a shown null slot as non-whitelist | It disappears from the calendar on next load. Expected per the fail-open trade-off. |
| ShopCh busy page (`アクセスが集中`) during forward scrape | Treated as retryable error (existing logic); that date is skipped, **no reconciliation** for it. |
| QVC monthly refresh fails mid-run | No reconciliation against a failed scrape; stale rows persist one more cycle rather than being wrongly deleted. |
| Forward slot moves from 14:00→16:00 | New row at 16:00 upserted; 14:00 stale row removed by reconciliation (future-only). |
| Reconciliation bug regresses to touch archived rows | Guard `archived_video_s3 IS NULL` + `air_date > today` makes archived destruction impossible even if the date filter is wrong. |

## 6. Success Criteria

- `verify:calendar-accuracy` shows `null-hidden` count no longer suppresses airing QVC slots (they now display).
- ShopCh shows non-zero slots for today and ≥ several future days on the calendar.
- A forward QVC slot that upstream removes disappears from the calendar within one refresh cycle; no archived video row is ever deleted.
- The MonthGrid "today" ring lands on the correct JST cell during JST morning hours.
- All four test suites pass.

## 7. Out-of-Scope Future Work

- A visible "未分類" badge for null-category slots (brainstorm chose plain fail-open, not the labeled variant).
- Deeper QVC wrong-day audit if `formatISODate`'s local-time methods ever misbehave under a non-UTC runtime (currently consistent; noted as fragile).
- ShopCh product/category enrichment for forward slots (so the whitelist applies forward too) — depends on ShopCh JSON `pgmcategory`, already captured at scrape time where present.
