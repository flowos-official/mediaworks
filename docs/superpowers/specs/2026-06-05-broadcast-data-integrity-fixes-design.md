# Broadcast Data Integrity Fixes — Design

**Date:** 2026-06-05
**Status:** Approved (design)
**Author:** Claude (with jp@flowos.work)

## Context

Three follow-up items surfaced while verifying the broadcast calendar after the
2026-06-03 fixes (commit `8e69f3d`: ropping crawl, ShopCh playback, QVC archive
lag) and answering a stakeholder question about calendar accuracy:

1. The ShopCh playback-badge UX fix (spinning `Loader2` → static "アーカイブ待ち"
   chip) is committed locally (`dd39065`) but **not pushed to prod**.
2. **36 broadcast slots stuck in `video_status='abandoned'`** — all from
   2026-05-23 (23) and 2026-05-24 (13), all with `video_download_attempts=5`.
   Investigation: **all 36 already have `archived_video_s3` set** — the video
   exists in S3. These are residue from the 2026-06-02 `daily:archive` footgun
   (mass re-queue / ~178GB re-download); the status got stuck at `abandoned`
   even though the object is present. Not a missing-video problem — a stuck-status
   problem.
3. The calendar occasionally shows a slot that **was not actually broadcast**
   (last-minute schedule change). Current reconciliation (`lib/broadcasts/
   reconcile.ts`) is **future-only** (`isoDate > todayIso`), so a slot
   cancelled/changed after its air date is never auto-removed.

These are independent and do not touch each other's code paths.

## Non-goals

- No schema changes / migrations.
- No change to the **whitelist display gate** — QVC ジュエリー/グルメ being hidden
  is intentional policy ("broadcast but not shown" is by design, not a bug).
- No rolling multi-day past reconcile (YAGNI — yesterday-only chosen). Changes
  older than yesterday remain a known, accepted limitation.
- No touching the in-flight `compliance-rules` working-tree changes; every commit
  here stages only the files listed below.

## Item 1 — Push the ShopCh chip fix

Commit `dd39065` (already on local `main`) → `git push origin main` → Vercel
auto-deploys prod. No code change. Outward-facing, so requires explicit user
go-ahead at push time.

## Item 2 — Recover the 36 abandoned-but-archived slots

A one-shot recovery script, registered as an npm script.

**File:** `scripts/recover-abandoned-archived.ts`
**npm script:** `recover:abandoned-archived`

Logic:
```
UPDATE broadcasts
  SET video_status = 'archived'
  WHERE video_status = 'abandoned'
    AND archived_video_s3 IS NOT NULL
```
Implemented via supabase-js with a CAS guard so only exactly this case is
touched:
```ts
sb.from("broadcasts")
  .update({ video_status: "archived" })
  .eq("video_status", "abandoned")
  .not("archived_video_s3", "is", null)
  .select("id, channel, air_date");
```

- **No re-download** — the S3 object already exists; only the status row flips.
- Genuinely failed slots (abandoned with **no** `archived_video_s3`) are left
  untouched — those are real missing videos, out of scope here.
- Script prints a before/after count and the affected (channel, air_date) list.
- Idempotent: a second run flips 0 rows.

**Verification:** run the script; confirm `abandoned` count drops by 36 and
`archived` rises by 36; confirm the ▶ play button reappears for a 2026-05-23 /
2026-05-24 slot on the calendar.

## Item 3 — Yesterday-only reconciliation

Extend reconciliation so the daily re-scrape of *yesterday* also removes slots
that are in the DB but absent from yesterday's actual aired lineup.

### Why yesterday is safe to reconcile

`daily-broadcasts` already re-scrapes yesterday and gets the **actual** aired
lineup. The existing `reconcileFutureSlots` delete query already carries the
guards that make deletion safe regardless of date:

- `archived_video_s3 IS NULL` → an archived recording can **never** be deleted.
- `video_status NOT IN (downloading, archived)` → belt-and-suspenders on the same.
- caller gates on `scrapedSlotCount > 0` → never reconcile against an empty /
  failed scrape (which would wipe a whole day on a transient upstream error).

A yesterday slot that genuinely aired and was recorded is protected by the
archived-video guard. A stale forward-published slot that never aired has no
video and is correctly removed.

### Changes

1. **`lib/broadcasts/reconcile.ts`** — add:
   ```ts
   export function shouldReconcileYesterday(
     isoDate: string,
     yesterdayIso: string,
     scrapedSlotCount: number,
   ): boolean {
     return isoDate === yesterdayIso && scrapedSlotCount > 0;
   }
   ```
   The caller passes the yesterday string it already computed via the existing
   `lib/broadcasts/jst-date.ts::getYesterdayJST` (already imported in
   `daily-broadcasts/route.ts`) — no new date helper. Reuse the existing
   `reconcileFutureSlots(channel, isoDate, keepStartTimes)` delete unchanged.

2. **`app/api/cron/daily-broadcasts/route.ts`** — after persisting yesterday's
   QVC/ShopCh scrape, if `shouldReconcileYesterday(scrapedDate, yesterday, count)`
   (where `scrapedDate === yesterday` here — the param exists for symmetry with
   `shouldReconcileDate` and to keep the guard unit-testable), call
   `reconcileFutureSlots(channel, yesterday, keepStartTimes)` per channel and add
   the deleted count to the cron summary/log.

### Scope limitation (explicit)

Only **yesterday** is reconciled. A last-minute change that happened on a date
older than yesterday is not auto-corrected — accepted trade-off (avoids the
scrape load and larger blast radius of a rolling window).

### Tests

- **Unit** (`shouldReconcileYesterday`): yesterday + non-empty → true;
  today / older / future → false; yesterday + empty scrape → false.
- **Live, skip-guarded** (`.env.local` required): insert a synthetic stale
  yesterday row (no `archived_video_s3`) plus a synthetic archived yesterday
  row; run reconcile with a `keepStartTimes` set excluding both; assert the
  stale row is deleted and the archived row survives. Clean up after.

## Rollout / commits

- Each item committed separately, staging **only** its own files (the working
  tree also contains unrelated `compliance-rules` WIP that must not be swept in):
  - Item 1: `git push` only (no new commit).
  - Item 2: `scripts/recover-abandoned-archived.ts` + the one `package.json`
    script line (staged via patch to avoid the compliance `package.json` edit).
  - Item 3: `lib/broadcasts/reconcile.ts`,
    `app/api/cron/daily-broadcasts/route.ts`, test file(s).
- `npx tsc --noEmit` clean before any commit.
- No migrations.

## Risks

| Risk | Mitigation |
|------|-----------|
| Item 2 flips a slot whose S3 object is actually broken | Guard requires `archived_video_s3 IS NOT NULL`; S3 keys for these 36 were written by a successful prior archive. Low. Re-archive path still exists if a key is later found dead. |
| Item 3 deletes a real aired+archived slot | Delete query guards (`archived_video_s3 IS NULL`, status not downloading/archived) make this impossible. |
| Item 3 wipes a day on a partial/failed scrape | `scrapedSlotCount > 0` gate; yesterday-only. |
| Commits sweep in compliance WIP | Per-item file-scoped staging; verify `git diff --cached` before each commit. |
