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
- No **deletion** of past slots in this drop. Item 3 is detect-and-log only
  (Phase 1); auto-removal (two-strikes) is deferred to a data-informed Phase 2.
- No rolling multi-day past reconcile. Changes older than yesterday remain a
  known, accepted limitation.
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

The update also clears `video_error: null` in the same statement. The only
normal code path that sets `archived_video_s3` writes `video_status='archived'`
**and** `video_error: null` atomically (`lib/broadcasts/video-archival.ts:148`);
leaving `video_error` populated would make a recovered row read as
"archived after a failure with an error message" on `/admin/archive-status`.
`video_download_attempts` is left as-is (harmless; status is the operative field).

- **No re-download** — the S3 object already exists; only the status row flips.
- Genuinely failed slots (abandoned with **no** `archived_video_s3`) are left
  untouched — those are real missing videos, out of scope here.
- Script prints a before/after count and the affected (channel, air_date) list.
- Idempotent: a second run flips 0 rows.
- **Reuse signal:** the script is registered as a reusable npm command, so any
  future run that flips a non-zero count is itself evidence the footgun (or a
  similar out-of-band mutation) recurred — the script logs a prominent warning
  in that case so the count is investigated rather than silently "fixed".

**Verification:** run the script; confirm `abandoned` count drops by 36 and
`archived` rises by 36; confirm the ▶ play button reappears for a 2026-05-23 /
2026-05-24 slot on the calendar.

## Item 3 — Yesterday reconciliation: **detect-and-log only (Phase 1)**

### Why NOT blind auto-delete

Two independent reviews rejected auto-deleting yesterday's stale slots. The
reasons are concrete and verified against the code:

- The existing `reconcileFutureSlots` delete guards (`reconcile.ts:43-44`) only
  protect `archived_video_s3 IS NOT NULL` and `video_status IN
  (downloading,archived)`. Normal slots in `pending / queued / deferred /
  abandoned` are **not** protected.
- QVC parser creates every slot with `category: null` (`qvc.ts:136`) and only
  later attaches a category from cached `qvc_products` (`qvc.ts:154`). So a slot
  that **genuinely aired yesterday** can legitimately be `category=null`,
  `video_status IN (pending,queued,deferred)`, `archived_video_s3=null` — i.e.
  indistinguishable by row state from a stale forward slot that never aired.
- `scrapedSlotCount > 0` proves the scrape is *non-empty*, not *complete*. A
  partial re-scrape that drops 1–2 slots passes the gate, and a "completeness
  ratio + delete cap" only bounds blast radius — it is **not** a correctness
  guarantee (e.g. 22/24 returned = 91.6% passes, 2 real slots wrongly deleted).

Therefore Phase 1 **deletes nothing**. It detects stale candidates and surfaces
them; deletion (if ever) is a separate, data-informed Phase 2. This mirrors the
project's existing "observe before automating" pattern (`historical_crawl_runs`).

### Changes (Phase 1)

1. **`lib/broadcasts/reconcile.ts`** — add two pure, unit-testable helpers
   (no delete, no I/O):
   ```ts
   // Whether this channel's yesterday scrape is trustworthy enough to compute
   // candidates from. Per-channel success + non-empty + completeness sanity.
   export function canReconcileYesterday(
     channelOk: boolean,
     scrapedSlotCount: number,
     existingDbCount: number,
   ): boolean { ... }   // ok && scraped>0 && scraped >= ceil(existingDbCount * RATIO)

   // Rows present in DB for (channel, date) but absent from the scraped
   // start_time set — the stale candidates. Pure set difference.
   export function staleCandidates(
     dbRows: { id: string; start_time: string; ... }[],
     keepStartTimes: string[],
   ): typeof dbRows { ... }
   ```
   `reconcileFutureSlots` is left **unchanged** (still future-only). No new
   delete path is added.

2. **`app/api/cron/daily-broadcasts/route.ts`** — after persisting yesterday's
   scrape, for **each channel independently**:
   - read that channel's own `ScrapeResult` (`qvcResult` / `shopchResult` from
     `summary.results`), use only if `result.ok`;
   - `keepStartTimes = result.slots.map(s => s.start_time)` (same derivation as
     the future reconcilers, `qvc-monthly.ts:87` / `shopch-forward.ts:81`) —
     never cross channels;
   - read existing DB rows for `(channel, targetIso)`;
   - if `canReconcileYesterday(result.ok, slots.length, existingDbCount)`,
     compute `staleCandidates(...)` and **log them** (count + per-slot
     channel/start_time/status) to `console` and into the cron summary field
     `reconcileCandidates`. If the gate fails, log `skipped: incomplete-scrape`.
   - **No deletion.**

   (`targetIso` is the cron's existing yesterday variable from `getYesterdayJST`;
   there is no separate "today" needed and no tautological guard param.)

### What this catches / misses

- **Catches:** surfaces "in DB but not in yesterday's actual lineup" slots so an
  operator can see how often real stale-past slots occur and whether Phase 2 is
  even warranted.
- **Whitelist-hidden slots are NOT false candidates:** the scraper returns ALL
  slots (whitelist filtering is display-time only, `UnifiedDayDetailPanel.tsx:114`;
  `qvc.ts:198-202` "DO NOT drop non-whitelist slots"), so hidden-but-aired slots
  are in `keepStartTimes` and never flagged.
- **Misses (accepted):** changes older than yesterday; and Phase 1 does not act
  on candidates — it only reports. Auto-deletion remains deliberately deferred.

### Phase 2 (deferred, not in this drop)

If the logs show real, frequent stale-past slots worth auto-removing, the safe
mechanism is **two-strikes**: delete only a candidate confirmed missing across
two independent successful scrapes. That requires persisting the first strike
(a nullable column on `broadcasts`) → a manual migration (this repo applies
migrations by hand). Out of scope until Phase 1 data justifies it.

### Tests (Phase 1)

- **Unit `canReconcileYesterday`:** ok+complete → true; `ok=false` → false;
  `scraped=0` → false; scraped below completeness ratio → false.
- **Unit `staleCandidates`:** a DB row absent from keep → flagged; a DB row
  present in keep (incl. a whitelist-hidden category) → not flagged; empty keep
  → (caller already gated, but) returns all / is never called.
- No live-delete test needed — Phase 1 performs no deletion.

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
| Item 3 deletes a real aired-but-not-yet-archived slot | **Eliminated by design** — Phase 1 performs no deletion at all. Candidates are only logged. |
| Item 3 logs noisy false candidates on a partial scrape | `canReconcileYesterday` per-channel-success + completeness-ratio gate; below ratio → `skipped: incomplete-scrape`, no candidate list. (Noise only, never data loss.) |
| Commits sweep in compliance WIP | Per-item file-scoped staging; verify `git diff --cached` before each commit. |
