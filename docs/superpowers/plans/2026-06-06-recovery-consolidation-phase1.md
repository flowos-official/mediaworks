# Recovery Consolidation Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight `mode: "heal"` to `reconcileArchiveCoverage` and wire it into the every-2h archive-videos cron as the primary healer, keeping the three pending/deferred sweeps as fallback (so their drop to ~0 activity proves parity before Phase 2 removes them).

**Architecture:** `reconcileArchiveCoverage` gains an `opts.mode` (default `"audit"` = unchanged). In `"heal"` mode it does the load + probe + requeue, then early-returns before coverage/record/alert — same `ReconcileResult` type, only `healed`/`probed`/`no_source`/`window`/`duration_ms` populated. The archive-videos cron calls it first (before the existing sweeps) and surfaces the result. No removals this phase.

**Tech Stack:** Next.js App Router (cron route handler), Supabase (`getServiceClient`), TypeScript, `tsx` smoke scripts. Spec: `docs/superpowers/specs/2026-06-06-recovery-consolidation-design.md`. Branch: `feat/recovery-consolidation` (already checked out; spec committed there).

---

## File Structure

| File | Change |
|------|--------|
| `lib/broadcasts/archive-reconciliation.ts` | Add `mode?: "audit" \| "heal"` to `ReconcileOptions`; resolve it; early-return in `reconcileArchiveCoverage` when `mode === "heal"` (skip coverage/record/alert). |
| `scripts/test-archive-reconciliation-heal.ts` | NEW live test for heal mode (isolated sentinels, own window date). |
| `app/api/cron/archive-videos/route.ts` | Call `reconcileArchiveCoverage({ mode: "heal", … })` first; add `reconcileHeal` to the response. |
| `package.json` | Add `test:archive-reconciliation-heal` alias. |

**Conventions:** no `import "server-only"` in `archive-reconciliation.ts` (tsx-imported). Run live tests with `npx tsx --env-file=.env.local …`; unit/heal tests that touch the DB need `--env-file`. The `archive_reconciliation_runs` migration is already applied in the live DB. Commit per task with the exact messages below.

---

## Task 1: `heal` mode on the orchestrator

**Files:**
- Create: `scripts/test-archive-reconciliation-heal.ts`
- Modify: `lib/broadcasts/archive-reconciliation.ts` (`ReconcileOptions` ~line 120-127; `reconcileArchiveCoverage` ~line 165-288)

- [ ] **Step 1: Write the failing live test**

Create `scripts/test-archive-reconciliation-heal.ts`:

```ts
/**
 * Live-DB test for reconcileArchiveCoverage mode:"heal" (self-cleaning, no network).
 *   npx tsx --env-file=.env.local scripts/test-archive-reconciliation-heal.ts
 * Heal mode must requeue healable slots but SKIP coverage/record/alert: no
 * archive_reconciliation_runs row, no webhook. Isolated from the audit test by a
 * distinct sentinel date (2020-01-03) and window (now=2020-01-10).
 */
import { getServiceClient } from "../lib/supabase";
import { reconcileArchiveCoverage, type ReconcileSlot } from "../lib/broadcasts/archive-reconciliation";

const PAST = "2020-01-03"; // distinct from the audit test's 2020-01-02
const HEAL_WINDOW_TO = "2020-01-10";
const CH = "shopch";
const WL = "TESTWL";
const whitelist = new Map<string, Set<string>>([["shopch", new Set([WL])], ["qvc", new Set([WL])]]);

let failures = 0;
function ok(c: boolean, m: string) { if (c) console.log(`  ok: ${m}`); else { console.error(`  FAIL: ${m}`); failures++; } }

async function main() {
  const sb = getServiceClient();

  const probe = await sb.from("archive_reconciliation_runs").select("id").limit(1);
  if (probe.error && /relation .* does not exist/i.test(probe.error.message)) {
    console.log("SKIP: archive_reconciliation_runs table not present (apply migration first).");
    return;
  }

  async function cleanup() {
    await sb.from("broadcasts").delete().eq("channel", CH).eq("air_date", PAST);
  }
  await cleanup();

  const rows = [
    { start_time: "00:00:00", category: WL, video_status: "pending",   archived_video_s3: null, title: "H-video-pending" },
    { start_time: "01:00:00", category: WL, video_status: "abandoned", archived_video_s3: null, title: "H-video-abandoned" },
    { start_time: "02:00:00", category: WL, video_status: "pending",   archived_video_s3: null, title: "H-novideo-pending" },
  ];
  const { error: insErr } = await sb.from("broadcasts").insert(rows.map((r) => ({
    channel: CH, air_date: PAST, start_time: r.start_time, category: r.category,
    program_title: r.title, video_status: r.video_status, archived_video_s3: r.archived_video_s3,
    source_url: `https://test.invalid/recon-heal/${r.start_time}`,
  })));
  if (insErr) { console.error("setup insert failed:", insErr.message); process.exit(1); }

  const stubProbe = async (slot: ReconcileSlot) => slot.start_time !== "02:00:00"; // 02:00 has no video
  const sentWebhook: object[] = [];
  const stubWebhook = async (_url: string, body: object) => { sentWebhook.push(body); return { ok: true }; };

  const result = await reconcileArchiveCoverage({
    mode: "heal",
    lookbackDays: 99999, whitelist, probeVideo: stubProbe,
    webhookUrl: "https://hook.test/x", postWebhook: stubWebhook,
    now: new Date(`${HEAL_WINDOW_TO}T00:00:00Z`),
  });

  const { data: after } = await sb.from("broadcasts").select("start_time, video_status").eq("channel", CH).eq("air_date", PAST);
  const st = (t: string) => (after ?? []).find((r) => r.start_time === t)?.video_status;
  ok(st("00:00:00") === "queued", "heal: video+pending → requeued to queued");
  ok(st("01:00:00") === "abandoned", "heal: video+abandoned → untouched (no resurrect)");
  ok(st("02:00:00") === "pending", "heal: no-video+pending → untouched");
  ok(result.healed >= 1, "heal: result.healed counts the requeue");
  ok(result.unhealable === 0, "heal: unhealable is 0 (audit-only)");
  ok(result.no_source >= 1, "heal: no_source counts the no-video candidate");
  ok(result.alerted === false && sentWebhook.length === 0, "heal: NO webhook sent");

  // heal mode must NOT persist a run row for its window
  const { data: runs } = await sb.from("archive_reconciliation_runs").select("id").eq("window_to", HEAL_WINDOW_TO);
  ok((runs ?? []).length === 0, "heal: NO archive_reconciliation_runs row inserted");

  await cleanup();
  if (failures > 0) { console.error(`\n${failures} failed.`); process.exit(1); }
  console.log("\nall heal-mode assertions passed.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --env-file=.env.local scripts/test-archive-reconciliation-heal.ts`
Expected: FAIL — without `mode` support the call runs as AUDIT: it inserts a run row (`NO ...row inserted` fails), sends the webhook (`NO webhook sent` fails), and `result.unhealable` is `1` (`unhealable is 0` fails). (If it prints SKIP, the migration isn't applied — apply it, then it should fail as described.)

- [ ] **Step 3: Add `mode` to `ReconcileOptions`**

In `lib/broadcasts/archive-reconciliation.ts`, change the `ReconcileOptions` interface (currently ~line 120-127) to add `mode`:

```ts
export interface ReconcileOptions {
  mode?: "audit" | "heal";
  lookbackDays?: number;
  whitelist?: Map<string, Set<string>>;
  probeVideo?: ProbeFn;
  postWebhook?: WebhookFn;
  webhookUrl?: string;
  now?: Date;
}
```

- [ ] **Step 4: Resolve `mode` and early-return in heal mode**

In `reconcileArchiveCoverage`, after the line `const webhookUrl = opts?.webhookUrl ?? process.env.ALERT_WEBHOOK_URL ?? "";` (~line 173), add:

```ts
  const mode = opts?.mode ?? "audit";
```

Then, immediately after the candidate `for (const s of slots) { … }` loop closes and BEFORE the `// coverage` comment (~line 230, between line 229 `}` and line 231 `// coverage`), insert the heal early-return:

```ts
    // heal mode: requeue only — skip coverage/record/alert (the daily audit run owns those).
    if (mode === "heal") {
      return {
        window_from, window_to,
        expected_total: 0, archived_total: 0, coverage_pct: 0,
        healed, unhealable: 0, no_source, probed,
        coverage_by_day: [], gaps: [],
        alerted: false, alert_error: null,
        duration_ms: Date.now() - t0,
      };
    }
```

(`unhealable` and `gaps` remain computed by the loop and are still used by the audit path below; heal mode intentionally returns them as `0`/`[]` per spec.)

- [ ] **Step 5: Run heal test to verify it passes**

Run: `npx tsx --env-file=.env.local scripts/test-archive-reconciliation-heal.ts`
Expected: PASS — "all heal-mode assertions passed."

- [ ] **Step 6: Run the audit test + unit + tsc to confirm no regression**

Run: `npx tsx --env-file=.env.local scripts/test-archive-reconciliation.ts`
Expected: PASS — "all live assertions passed." (audit mode unchanged)
Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: PASS — "all unit assertions passed."
Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/broadcasts/archive-reconciliation.ts scripts/test-archive-reconciliation-heal.ts
git commit -m "feat(broadcasts): heal mode for reconcileArchiveCoverage (requeue only, no record/alert)"
```

---

## Task 2: Wire heal into the archive-videos cron

**Files:**
- Modify: `app/api/cron/archive-videos/route.ts` (import ~line 6; new block after ~line 43; result object ~line 142)

- [ ] **Step 1: Add the import**

In `app/api/cron/archive-videos/route.ts`, after the existing recovery imports (after line 6 `import { recoverShopChPending } …`), add:

```ts
import { reconcileArchiveCoverage } from "@/lib/broadcasts/archive-reconciliation";
```

- [ ] **Step 2: Add the reconcile-heal block as the FIRST recovery step**

Immediately after `const sb = getServiceClient();` (~line 43) and BEFORE the `// Self-heal: requeue slots orphaned in 'downloading'` comment (~line 45), insert:

```ts
  // Primary healer (consolidation Phase 1): outcome-driven reconciliation in heal
  // mode requeues any stuck whitelist slot whose video exists — superset of the
  // qvc/shopch pending/deferred sweeps below, which now run as fallback (their
  // counts should drop to ~0). Heal mode skips coverage/record/alert (the daily
  // archive-reconciliation cron owns those). Non-fatal.
  let reconcileHeal:
    | Awaited<ReturnType<typeof reconcileArchiveCoverage>>
    | { error: string } = {
    window_from: "", window_to: "", expected_total: 0, archived_total: 0,
    coverage_pct: 0, healed: 0, unhealable: 0, no_source: 0, probed: 0,
    coverage_by_day: [], gaps: [], alerted: false, alert_error: null, duration_ms: 0,
  };
  try {
    reconcileHeal = await reconcileArchiveCoverage({
      mode: "heal",
      lookbackDays: Number(process.env.RECONCILE_HEAL_LOOKBACK_DAYS) || 7,
    });
  } catch (err) {
    reconcileHeal = { error: err instanceof Error ? err.message : String(err) };
    console.warn("[archive-videos] reconcileArchiveCoverage(heal) failed:", reconcileHeal);
  }
```

- [ ] **Step 3: Add `reconcileHeal` to the response object**

Find the result line (~line 142):

```ts
  const result = { ...summary, qvcRecovery, shopchPendingRecovery };
```

Change it to:

```ts
  const result = { ...summary, reconcileHeal, qvcRecovery, shopchPendingRecovery };
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/archive-videos/route.ts
git commit -m "feat(broadcasts): run reconciliation heal as primary healer in archive-videos cron"
```

---

## Task 3: npm alias + final verification

**Files:**
- Modify: `package.json` (scripts block, near `test:archive-reconciliation`)

- [ ] **Step 1: Add the npm alias**

In `package.json` `scripts`, after the `"test:archive-reconciliation": …` line, add:

```json
    "test:archive-reconciliation-heal": "tsx --env-file=.env.local scripts/test-archive-reconciliation-heal.ts",
```

- [ ] **Step 2: Validate JSON + run the full suite**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('json ok')"`
Expected: `json ok`
Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npm run test:archive-reconciliation-unit`
Expected: "all unit assertions passed."
Run: `npm run test:archive-reconciliation`
Expected: "all live assertions passed."
Run: `npm run test:archive-reconciliation-heal`
Expected: "all heal-mode assertions passed."

- [ ] **Step 3: Manual smoke of heal mode against the real DB (read-mostly)**

Run: `npx tsx --env-file=.env.local -e "import('./lib/broadcasts/archive-reconciliation.ts').then(async m => { const r = await m.reconcileArchiveCoverage({ mode: 'heal', lookbackDays: 7 }); console.log(JSON.stringify(r)); })"`
Expected: a JSON result with `healed`/`probed`/`no_source` and `coverage_by_day: []`, `gaps: []`, `alerted: false`. With the drained backlog, expect `healed: 0`. **No `archive_reconciliation_runs` row should be added** (heal mode). (If the inline `import()` form errors under tsx, skip this optional smoke — the heal live test already exercises the path against the DB.)

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(broadcasts): npm alias for heal-mode test"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §4.1 heal mode (skip coverage/record/alert; same `ReconcileResult` type; lookback from `RECONCILE_HEAL_LOOKBACK_DAYS`) → Task 1 (Steps 3-4) + Task 2 (Step 2 passes the env lookback).
- §4.2 cron wiring (heal first, before sweeps; `reconcileHeal` in response; sweeps unchanged; daily-broadcasts/qvc-monthly/audit-cron unchanged) → Task 2. The three sweeps and `recoverStaleDownloading` are deliberately left in place (not touched) — correct for Phase 1.
- §4.3 parity observability (response carries `reconcileHeal` + sweep results) → Task 2 Step 3.
- §4.4 lookback edge (`RECONCILE_HEAL_LOOKBACK_DAYS` default 7) → Task 2 Step 2.
- §5 testing (heal live test: requeue O, no run row, no webhook; audit + unit no regression; tsc) → Task 1 Steps 1-6, Task 3 Step 2.
- §6 Phase 2 (removals) → intentionally NOT in this plan.

**Deviation from spec (documented):** §5 said "extend `test-archive-reconciliation.ts`"; this plan instead adds a SEPARATE `test-archive-reconciliation-heal.ts`. Rationale: isolating heal sentinels (own date 2020-01-03, own window 2020-01-10) avoids coupling with the audit test's run-row assertion and keeps each test single-purpose. Functionally equivalent coverage.

**Placeholder scan:** none — every step has complete code/commands.

**Type consistency:** `mode?: "audit" | "heal"` added to `ReconcileOptions` and read as `opts?.mode ?? "audit"`; the heal early-return constructs a full `ReconcileResult` (all 15 fields present, matching the interface at lines 100-115). The cron's `reconcileHeal` placeholder object matches the same 15-field shape (union with `{ error }`, mirroring the existing `qvcRecovery`/`shopchPendingRecovery` pattern). `reconcileArchiveCoverage` call sites use the documented option names.
