# Archive Coverage Reconciliation — Design

- **Date:** 2026-06-06
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Author:** brainstormed with operator
- **Related:** `lib/broadcasts/video-archival.ts`, `lib/broadcasts/shopch-pending-recovery.ts`, `app/api/cron/archive-videos/route.ts`, `lib/historical-crawl/runs.ts` (observability pattern), memory `project-shopch-scrape-gotchas` (#3–#7)

## 1. Problem

The video-archival pipeline has leaked silently in five distinct ways (memory #3–#7): slots stuck in `downloading`, `deferred`, `pending` (zero-product), `abandoned` (403 not-yet-aired), plus a throughput cap. Each fix added a **state-specific, cause-specific recovery sweep** (`recoverStaleDownloading`, `recoverQvcPending`, `recoverShopChDeferred`, `recoverShopChPending`). This is whack-a-mole: every new code path creates a new way for a slot to get stranded, and each needs its own bespoke recovery. Failures are **silent** — discovered only by manual audit — so they accumulate (the April ShopCh backlog of 58 slots) before anyone notices.

The structural gap: **there is no single check that asks the outcome question** — "did every slot that should have a video actually get archived?" — independent of *why* a slot is stuck. And there is **no alerting**, so breakage is invisible until someone looks.

## 2. Goals / Non-goals

**Goals (this iteration — MVP):**
- A single **outcome-driven daily reconciliation**: for every aired, whitelist slot whose video exists, ensure it is archived; self-heal gaps by requeueing **regardless of which stuck state** they are in.
- **Coverage visibility** on the existing admin dashboard.
- **Active alerting** (webhook push) only for **genuine un-healable gaps** (video exists but cannot be archived → needs a human).
- Robust to *new, unknown* failure modes because it keys on the outcome, not the cause.

**Non-goals (deferred to later iterations):**
- Consolidating/removing the existing four recovery sweeps. They stay; this layer sits on top (redundant but harmless). Revisit once reconciliation has proven itself.
- Decoupling `video_status` from product-snapshot enrichment (the root coupling behind #7). Separate follow-up.
- Email alerting; any non-webhook channel.
- Resurrecting terminal `abandoned`/`failed*` slots automatically (we alert instead — see §4).

## 3. Requirements (decided)

| # | Decision |
|---|----------|
| Scope | MVP = reconciliation (self-heal) + alerting. Existing recoveries left in place. |
| Alert channel | Dashboard coverage gate **+ Slack/Discord webhook push**. |
| Cadence / window | **Daily** dedicated cron, **7-day** lookback (re-checks the past week each run). |
| Alert trigger | **Only genuine un-healable gaps** (video exists, stays un-archived). "No source video" → terminal/excluded, never alerts. |

## 4. Architecture & Components

```
[cron JST 06:00 = 21:00 UTC]  app/api/cron/archive-reconciliation/route.ts
        │
        ▼
[core]  lib/broadcasts/archive-reconciliation.ts :: reconcileArchiveCoverage(opts)
        │  1. window = [today-7d, today) JST, qvc+shopch whitelist slots
        │  2. split archived vs candidate; probe only stuck candidates
        │  3. decision tree → requeue (heal) | alert-worthy | skip
        │  4. coverage per (channel, air_date)
        │  5. record run → archive_reconciliation_runs
        │  6. webhook on un-healable gaps (deduped vs previous run)
        ▼
[heal]  requeued '→queued' slots are downloaded by the existing archive-videos cron (every 2h).
        Reconciliation NEVER downloads itself — it only probes + flips status + records + alerts.
[table] archive_reconciliation_runs (admin RLS; historical_crawl_runs pattern)
[view]  /admin/archive-status — add a coverage-gate panel (green/amber/red per recent day)
[alert] lib/alerts/webhook.ts — POST to ALERT_WEBHOOK_URL (Slack/Discord compatible)
```

**Principle:** reconciliation reads only the **outcome** ("aired + whitelist + video-exists + not-archived"), so it is automatically robust to failure modes we have not seen yet. The four existing recoveries remain as the first line; this catches whatever they miss, at the result level.

## 5. Algorithm

### 5.1 Candidate selection
- Window: `air_date >= today_JST - 7d AND air_date < today_JST` (strictly past = aired).
- Channels: `qvc`, `shopch`. Whitelist filter via `loadWhitelist()` + `isAllowed()`.
- Split: `archived` (has `archived_video_s3`) vs `candidate` (not archived).
- **Probe-savings:** `archived` is known-good (no probe). Among candidates, `queued`/`downloading` are **in-flight** (will archive on the next cron tick) → skip, no probe. **Only `pending`/`deferred`/`abandoned`/`failed`/`failed_unsupported` candidates are probed.**

### 5.2 Video-existence probe
- **QVC:** lead product's `qvc_products.video_url` is non-null (batch DB read — no HTTP).
- **ShopCh:** `GET https://www.shopch.jp/m3u8/prog/{programId}/{programId}_jwplayer.m3u8` with `Range: bytes=0-0` → `200`/`206` = exists, `403`/`404` = no source. Concurrency-limited (default 5).

### 5.3 Decision tree (per probed candidate)
```
video exists?
 ├─ NO  (403/404 / no video_url)            → skip. Not a gap (no source to archive). No alert.
 └─ YES
      ├─ status ∈ {pending, deferred}        → requeue → 'queued' (CAS-guarded). [healed-this-run]
      └─ status ∈ {abandoned, failed,
                   failed_unsupported}        → DO NOT auto-resurrect (avoid 5-retry loop).
                                                [alert-worthy: real video, terminal failure]
```
`queued`/`downloading` candidates were already excluded in 5.1 (in-flight).

### 5.4 Alert selection (dedup — "genuine un-healable only")
A gap (video-exists + not-archived) is **alert-worthy** if EITHER:
- its status is a terminal failure (`abandoned`/`failed`/`failed_unsupported`) despite a real video, **OR**
- it was also a gap in the **previous** reconciliation run (we requeued it last cycle and it still did not archive → not healing).

First-seen `pending`/`deferred` gaps are **requeued silently** — no alert — giving the archive cron a chance before the next daily run. Previous-run gap IDs are read from the latest `archive_reconciliation_runs.gaps`.

### 5.5 Coverage (dashboard only; NOT the alert trigger)
Per `(channel, air_date)`:
```
expected  = archived + (video-exists candidates)      // excludes no-source + in-flight
coverage% = archived / expected                        // expected==0 → treat as 100% (n/a)
```
Gate colors (env-tunable): green ≥ 98%, amber ≥ 90%, red < 90%. No-source slots are excluded from `expected`, so they never depress coverage (correct: nothing to archive).

## 6. Data model

New table `archive_reconciliation_runs`:

| column | type | notes |
|--------|------|-------|
| `id` | uuid pk default gen_random_uuid() | |
| `ran_at` | timestamptz not null | set by app (avoid Date in workflow scripts; cron uses `new Date()`) |
| `window_from`, `window_to` | date | inclusive-from, exclusive-to |
| `channels` | text[] | `{qvc,shopch}` |
| `expected_total`, `archived_total` | int | |
| `coverage_pct` | numeric(5,2) | overall |
| `healed`, `unhealable`, `no_source`, `probed` | int | result counts |
| `coverage_by_day` | jsonb | `[{channel,air_date,expected,archived,coverage}]` |
| `gaps` | jsonb | `[{broadcast_id,channel,air_date,start_time,status,classification,reason}]` (dedup source + detail) |
| `alerted` | bool default false | webhook fired this run |
| `alert_error` | text | webhook delivery failure (non-fatal) |
| `duration_ms` | int | |
| `error` | text | run-level failure |
| `created_at` | timestamptz default now() | |

**RLS (Group B — internal/admin):** enable RLS; `SELECT` policy for `admin` role; no INSERT/UPDATE/DELETE policy (writes only via service-role cron, which bypasses RLS). Mirrors `historical_crawl_runs`.

**Migration:** `supabase/migrations/2026-06-06_archive_reconciliation_runs.sql`. Applied **manually** by the operator (no CLI/db:push in repo). Live tests skip-guard when the table is absent.

## 7. Webhook

`lib/alerts/webhook.ts :: postReconciliationAlert(unhealableGaps, coverageSummary, opts?)`:
- Reads `ALERT_WEBHOOK_URL`. If unset → no-op (logs a warning), `alerted=false`. Never throws into the cron.
- Body sends **both** `{ text, content }` (Slack reads `text`, Discord reads `content`).
- `postWebhook` is an injectable function (default `fetch`) so tests stub it (no real network).

Message:
```
🚨 Archive reconciliation — N un-healable gaps (video exists, not archived)
  • [shopch] 2026-06-01 15:00 "…" — abandoned, 5 attempts
  • [qvc]    2026-05-30 20:00 "…" — persisted 2 cycles
Coverage (7d): qvc 100% (25/25) · shopch 96% (24/25)
→ /admin/archive-status
```

## 8. Cron

- Route: `app/api/cron/archive-reconciliation/route.ts`, `Bearer ${CRON_SECRET}` auth (mirror existing cron auth), `maxDuration` ~120s (probe + flips are light).
- Schedule (`vercel.json`): `0 21 * * *` = **JST 06:00**. By then yesterday's slots have had the 01:00 JST scrape + several every-2h archive ticks to complete, so same-day gaps are real, not lag.
- Returns the run summary JSON (and logs it), like the other crons.

## 9. Admin dashboard

Extend `app/[locale]/(admin)/admin/archive-status/page.tsx`:
- New "Coverage (last 7 days)" panel reading the latest `archive_reconciliation_runs` row: per-channel-per-day coverage with green/amber/red gate, plus the current gap list (healed vs un-healable). Keeps the existing status tally + failures table.

## 10. Env vars

| var | default | purpose |
|-----|---------|---------|
| `ALERT_WEBHOOK_URL` | (unset → alerts disabled) | Slack/Discord incoming webhook |
| `RECONCILE_LOOKBACK_DAYS` | 7 | window |
| `RECONCILE_COVERAGE_RED` / `_AMBER` | 90 / 98 | gate thresholds (%) |
| `RECONCILE_PROBE_CONCURRENCY` | 5 | ShopCh m3u8 probe lanes |

## 11. Testing (TDD)

Repo pattern: DB-free unit tests + skip-guarded live test (migrations applied manually).

- **Unit (pure):**
  - `classifyCandidate(status, videoExists)` → `requeue | alert | skip` — all branches.
  - `computeCoverage(slots)` — excludes no-source + in-flight; expected==0 → n/a.
  - `selectAlertWorthy(gaps, prevGaps)` — terminal OR persisted-across-runs; first-seen pending/deferred excluded.
  - `buildWebhookPayload(...)` — message format, both keys present.
- **Live (skip-guarded, self-cleaning sentinels)** — mirrors `test-shopch-pending-recovery`: injected whitelist + **stubbed probe** + sentinel slots covering every branch (video+pending→requeued; video+abandoned→alert-worthy; no-video→skip; archived→untouched; queued/downloading→skipped) + verify the `archive_reconciliation_runs` row. `postWebhook` stubbed (no network).
- Manual runner `scripts/reconcile-archive.ts`; npm aliases `reconcile:archive`, `test:archive-reconciliation`.

## 12. Out of scope / future

- Consolidating the four existing recovery sweeps into this reconciliation (remove duplication) once it has proven itself.
- Decoupling `video_status` assignment from product-snapshot enrichment (root cause of #7).
- Auto-resurrecting `abandoned` slots with bounded retries.
- Unioning the `historical_broadcasts` OA channels once they have a whitelist + archival path.
- Email / multi-channel alerting; alert escalation/ack.

## 13. Known limitations (MVP)

- **Persistently in-flight slots are not independently flagged.** A slot stuck in `queued`/`downloading` is trusted to the archive-videos pipeline (excluded from probe + alert per §5.1). The every-2h time-budgeted drain (memory #4) makes a permanently-starved `queued` unlikely, and a genuinely-failing one transitions to `deferred`/`abandoned` and is caught on the next reconciliation run. If starvation re-emerges, add an "age-of-queue" check (flag `queued` older than N days).
- **One-run dedup memory.** Alert dedup compares only against the *previous* run's gaps (§5.4); a gap that flickers (gap → healed → gap) resets its "persisted" age. Acceptable for daily cadence.
