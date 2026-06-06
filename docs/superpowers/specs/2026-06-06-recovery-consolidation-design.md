# Recovery Consolidation (Phase 1) — Design

- **Date:** 2026-06-06
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Scope:** Phase 1 of consolidating the per-state recovery sweeps into the outcome-driven reconciliation
- **Related:** `docs/superpowers/specs/2026-06-06-archive-reconciliation-design.md` (the reconciliation it builds on), memory `project-archive-reconciliation`, `project-shopch-scrape-gotchas` (#3–#7)

## 1. Problem

The video-archival pipeline accumulated four per-state recovery sweeps over five whack-a-mole iterations (memory #3–#7):

| sweep | wired into (cadence) | state it heals |
|-------|----------------------|----------------|
| `recoverStaleDownloading` | archive-videos (every 2h) | `downloading` orphan (dead worker claim) |
| `recoverQvcPending` | archive-videos (2h) + daily-broadcasts (daily) + qvc-monthly-refresh (daily) | QVC `pending`→queued |
| `recoverShopChDeferred` | daily-broadcasts (daily) | ShopCh `deferred`→queued |
| `recoverShopChPending` | archive-videos (2h) | ShopCh `pending`→queued |

The new daily reconciliation (`reconcileArchiveCoverage`) is a **functional superset** of the three pending/deferred sweeps: it requeues any stuck `pending`/`deferred` whitelist slot whose video exists, for BOTH channels and BOTH states — so the three are now duplicated logic. `recoverStaleDownloading` is a different mechanism (age + attempt-based claim timeout on the in-flight `downloading` state, not a coverage check) and is out of scope here.

But reconciliation runs **daily** while the sweeps heal **every 2h**, and reconciliation has **not yet run a single scheduled production cycle** (deployed 2026-06-06; first cron run JST 06:00 the next day). Removing proven sweeps outright is premature.

## 2. Decisions

| # | Decision |
|---|----------|
| Healing cadence | Preserve **every-2h** responsiveness (don't drop healing to once-daily). |
| Scope | Consolidate the **three** pending/deferred sweeps. **Keep `recoverStaleDownloading`** (distinct claim-timeout). |
| Removal | **Staged.** Phase 1 makes reconciliation the primary healer (sweeps remain as fallback); Phase 2 removes the sweeps after ~a week of observed parity. |
| Approach | **A — reconciliation-first, sweep-as-fallback.** |

## 3. Goals / Non-goals

**Goals (Phase 1):**
- A lightweight `mode: "heal"` on `reconcileArchiveCoverage` that requeues healable stuck slots every 2h without the cost of coverage computation / run-record / alert.
- Wire it into the every-2h archive-videos cron **before** the existing sweeps, so reconciliation becomes the primary healer and the sweeps drop to ~0 activity (the parity signal for Phase 2).
- Keep all existing sweeps running unchanged (fallback safety net during the observation window).

**Non-goals (Phase 1):**
- Removing any sweep or its code/tests/scripts — that is Phase 2.
- Touching `recoverStaleDownloading`.
- Changing the daily audit reconciliation (coverage + alert) behavior.
- Widening the heal lookback beyond the default (deferred to Phase 2, validated from observed data).

## 4. Phase 1 design

### 4.1 `heal` mode
`reconcileArchiveCoverage` gains `opts.mode?: "audit" | "heal"` (default `"audit"` = current full behavior, unchanged).

When `mode === "heal"`:
- Load whitelist slots in the window, probe **only stuck** non-archived candidates (`pending`/`deferred`/`abandoned`/`failed*`), classify, and **requeue** the healable ones (`pending`/`deferred` + video → `queued`, CAS-guarded) — identical to audit mode's requeue step.
- Then **early-return** before coverage/record/alert. It SKIPS: `computeCoverage`, `loadPreviousGapIds`, the webhook, and the `archive_reconciliation_runs` insert (both the success row and the error-path row). No DB record, no alert, no network beyond the probes.
- Errors propagate (caught by the caller's try/catch); heal mode never writes an audit row.
- **Return type:** same `ReconcileResult` shape (no new union type). In heal mode only `window_from`/`window_to`/`healed`/`probed`/`no_source`/`duration_ms` are meaningfully populated; `coverage_by_day`/`gaps` are `[]`, `coverage_pct`/`expected_total`/`archived_total`/`unhealable` are `0`, `alerted` is `false`, `alert_error` is `null`. The cron reads `.healed`/`.probed`/`.no_source`.
- **Lookback:** heal mode uses the `lookbackDays` passed by the caller; the cron passes `Number(process.env.RECONCILE_HEAL_LOOKBACK_DAYS) || 7` (the orchestrator keeps its existing `lookbackDays ?? (RECONCILE_LOOKBACK_DAYS || 7)` resolution for audit-mode callers). No new env logic inside the orchestrator.

`abandoned`/`failed*` candidates are probed (counted) but NOT requeued and NOT alerted in heal mode — they surface in the daily audit run instead.

### 4.2 Cron wiring (`app/api/cron/archive-videos/route.ts`, every 2h)
New first step, before the existing recoveries:
```
reconcileArchiveCoverage({ mode: "heal" })   ← NEW, primary healer (non-fatal try/catch)
recoverStaleDownloading()                     ← unchanged (downloading orphans)
recoverQvcPending()                           ← unchanged, now fallback (≈0)
recoverShopChPending()                        ← unchanged, now fallback (≈0)
drain loop                                    ← unchanged
```
The cron response JSON gains a `reconcileHeal` field alongside the existing `qvcRecovery` / `shopchPendingRecovery` / stale fields, so all four results are visible per run.

`daily-broadcasts` and `qvc-monthly-refresh` crons are **unchanged** (their `recoverQvcPending` / `recoverShopChDeferred` remain as fallback). The daily audit reconciliation cron is **unchanged**.

### 4.3 Parity observability (the Phase-2 gate)
Because reconciliation-heal runs first and requeues, the subsequent sweeps find nothing: their `queued` / `requeued` counts in the archive-videos cron response drop to **≈0**. Operator watches, over ~a week:
- `reconcileHeal.healed` ≥ the sum the sweeps used to do, AND
- `qvcRecovery.queued` / `shopchPendingRecovery.requeued` ≈ 0, AND
- daily audit `coverage_pct` stays ~100%.

That combination is the evidence that reconciliation fully covers the three sweeps → green-light Phase 2.

### 4.4 Lookback edge (known, deferred)
`recoverQvcPending` scans ALL QVC `pending` (no date floor); reconciliation uses `[today − RECONCILE_LOOKBACK_DAYS(7), today)`. A QVC `pending` slot older than 7 days would be healed by the fallback sweep but not by reconciliation-heal. This is **safe in Phase 1** (the sweep is still running). Heal lookback is exposed as `RECONCILE_HEAL_LOOKBACK_DAYS` (default 7); Phase 2 will set the right value from observed data before removing the sweep.

## 5. Testing

- **Live** (`scripts/test-archive-reconciliation.ts`, extended; self-cleaning sentinels, injected whitelist + stubbed probe + stubbed webhook): a `mode:"heal"` case asserting:
  - `video + pending` → requeued to `queued`.
  - `video + abandoned` → unchanged (heal does not resurrect or alert).
  - `no-video + pending` → unchanged.
  - `archived` / in-flight `queued` → unchanged.
  - **No `archive_reconciliation_runs` row inserted** for the heal run (query by the test's `window_to` sentinel → count 0).
  - **Stubbed webhook NOT called.**
  - returns `{ healed ≥ 1, probed ≥ 1, no_source ≥ 1 }`.
- **Audit-mode** existing live test + the unit tests must still pass (no regression — `audit` is the default and unchanged).
- `npx tsc --noEmit` clean. The cron route change is covered by tsc + the heal-mode live test (the cron itself is not triggered in tests).

## 6. Phase 2 outline (separate spec + PR, after ~1 week of observed parity)

1. Confirm parity: sweep counts ≈0, coverage ~100% across several real daily cycles.
2. Remove the three sweep calls from `archive-videos`, `daily-broadcasts`, `qvc-monthly-refresh` crons.
3. Delete `lib/broadcasts/{qvc-pending-recovery,shopch-deferred-recovery,shopch-pending-recovery}.ts` + their tests (`scripts/test-*`) + runner scripts (`scripts/recover-*`) + `package.json` aliases.
4. Set `RECONCILE_HEAL_LOOKBACK_DAYS` from observed data (cover the QVC all-pending tail) if needed.
5. Keep `recoverStaleDownloading`.

## 7. Risks & mitigations

- **Reconciliation misses an edge the sweep caught** → the fallback sweep still runs in Phase 1 and catches it; the sweep's non-zero count flags the divergence before Phase 2 removal.
- **Redundant work (both heal + sweep requeue same slot)** → harmless: CAS makes the second update a no-op; reconciliation-first means the sweep usually finds nothing.
- **Heal mode probes add HTTP load every 2h** → only stuck, non-archived candidates are probed (few in steady state); no coverage/record/alert overhead in heal mode.
