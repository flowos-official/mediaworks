# Archive Coverage Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily, outcome-driven reconciliation that ensures every aired whitelist slot whose video exists is archived — self-healing gaps regardless of which stuck state they're in — and webhook-alerts only genuine un-healable gaps.

**Architecture:** A pure-function core (classify / coverage / alert-selection / payload) wrapped by an orchestrator (`reconcileArchiveCoverage`) that loads whitelist slots in a 7-day window, probes only stuck non-archived candidates for video existence, requeues healable ones (`→queued`, picked up by the existing archive-videos cron), records the run to a new table, and pushes a Slack/Discord webhook for un-healable gaps. A daily cron drives it; the admin dashboard shows a coverage gate.

**Tech Stack:** Next.js App Router (route handlers), Supabase (`getServiceClient`, service-role/RLS-bypass for cron), TypeScript, `tsx` smoke scripts (no jest), ffmpeg-free (reconciliation never downloads). Spec: `docs/superpowers/specs/2026-06-06-archive-reconciliation-design.md`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `supabase/migrations/2026-06-06_archive_reconciliation_runs.sql` | New table + admin RLS (applied **manually**) |
| `lib/alerts/webhook.ts` | Generic `postWebhook(url, body, fetchImpl?)` |
| `lib/broadcasts/archive-reconciliation.ts` | Types, pure fns (`classifyCandidate`, `computeCoverage`, `selectAlertWorthy`, `buildWebhookPayload`), `defaultProbeVideo`, orchestrator `reconcileArchiveCoverage` |
| `app/api/cron/archive-reconciliation/route.ts` | Cron entrypoint (Bearer auth) |
| `app/[locale]/(admin)/admin/archive-status/page.tsx` | Coverage-gate panel (modify) |
| `scripts/test-archive-reconciliation-unit.ts` | DB-free unit tests (pure fns) |
| `scripts/test-archive-reconciliation.ts` | Live skip-guarded test (orchestrator) |
| `scripts/reconcile-archive.ts` | Manual runner |
| `vercel.json` | Cron schedule + maxDuration (modify) |
| `package.json` | npm aliases (modify) |

**Important conventions (from CLAUDE.md + memory):**
- Lib files imported by `tsx` scripts must NOT `import "server-only"`. `archive-reconciliation.ts` and `webhook.ts` are imported by smoke scripts → omit it. Use `getServiceClient` from `@/lib/supabase` (scripts import it as `../lib/supabase`).
- Migrations are applied manually (no CLI). Live tests must skip-guard when the table is absent.
- All work on branch `feat/archive-reconciliation` (already created; spec committed there).

---

## Task 1: Migration — `archive_reconciliation_runs` table

**Files:**
- Create: `supabase/migrations/2026-06-06_archive_reconciliation_runs.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 2026-06-06: archive coverage reconciliation run log (admin observability).
-- Applied manually (no supabase CLI in repo).
BEGIN;

CREATE TABLE IF NOT EXISTS archive_reconciliation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at          timestamptz NOT NULL,
  window_from     date NOT NULL,
  window_to       date NOT NULL,
  channels        text[] NOT NULL DEFAULT '{}',
  expected_total  int NOT NULL DEFAULT 0,
  archived_total  int NOT NULL DEFAULT 0,
  coverage_pct    numeric(5,2) NOT NULL DEFAULT 0,
  healed          int NOT NULL DEFAULT 0,
  unhealable      int NOT NULL DEFAULT 0,
  no_source       int NOT NULL DEFAULT 0,
  probed          int NOT NULL DEFAULT 0,
  coverage_by_day jsonb NOT NULL DEFAULT '[]'::jsonb,
  gaps            jsonb NOT NULL DEFAULT '[]'::jsonb,
  alerted         boolean NOT NULL DEFAULT false,
  alert_error     text,
  duration_ms     int,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archive_reconciliation_runs_ran_at_idx
  ON archive_reconciliation_runs (ran_at DESC);

ALTER TABLE archive_reconciliation_runs ENABLE ROW LEVEL SECURITY;

-- Group B (internal/admin): admins may read; writes only via service role (cron),
-- which bypasses RLS. Mirrors historical_crawl_runs.
DROP POLICY IF EXISTS arr_select_admin ON archive_reconciliation_runs;
CREATE POLICY arr_select_admin ON archive_reconciliation_runs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

COMMIT;
```

- [ ] **Step 2: Verify the file exists and is valid SQL syntax (visual check)**

Run: `git diff --stat` — confirm the file is created. (Cannot apply: no CLI. The operator applies it manually in Supabase SQL editor before the live test / first cron run.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-06-06_archive_reconciliation_runs.sql
git commit -m "feat(broadcasts): migration for archive_reconciliation_runs table"
```

> **NOTE for the operator:** apply this migration manually in Supabase before running `npm run test:archive-reconciliation` or enabling the cron. The RLS policy mirrors `historical_crawl_runs` — verify `profiles.role` column name matches your schema (it does as of 2026-06-06).

---

## Task 2: Pure fn `classifyCandidate` + types + unit-test scaffold

**Files:**
- Create: `lib/broadcasts/archive-reconciliation.ts`
- Create: `scripts/test-archive-reconciliation-unit.ts`

- [ ] **Step 1: Write the failing unit test**

Create `scripts/test-archive-reconciliation-unit.ts`:

```ts
/** DB-free unit tests for archive-reconciliation pure functions.
 *   npx tsx scripts/test-archive-reconciliation-unit.ts
 */
import { classifyCandidate } from "../lib/broadcasts/archive-reconciliation";

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`  ok: ${msg}`);
  else { console.error(`  FAIL: ${msg}\n    expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`); failures++; }
}

// --- classifyCandidate ---
eq(classifyCandidate("pending", true), "requeue", "pending + video → requeue");
eq(classifyCandidate("deferred", true), "requeue", "deferred + video → requeue");
eq(classifyCandidate("abandoned", true), "alert", "abandoned + video → alert");
eq(classifyCandidate("failed", true), "alert", "failed + video → alert");
eq(classifyCandidate("failed_unsupported", true), "alert", "failed_unsupported + video → alert");
eq(classifyCandidate("pending", false), "skip", "pending + no video → skip");
eq(classifyCandidate("abandoned", false), "skip", "abandoned + no video → skip");

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
console.log("\nall unit assertions passed.");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: FAIL — `Cannot find module '../lib/broadcasts/archive-reconciliation'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/broadcasts/archive-reconciliation.ts`:

```ts
/**
 * Outcome-driven archive coverage reconciliation. Spec:
 * docs/superpowers/specs/2026-06-06-archive-reconciliation-design.md
 * NOTE: intentionally NO `import "server-only"` — imported by tsx smoke scripts.
 */

export type VideoStatus =
  | "pending" | "queued" | "downloading" | "archived"
  | "deferred" | "failed_unsupported" | "abandoned" | "failed";

export type CandidateAction = "requeue" | "alert" | "skip";

const HEALABLE: ReadonlySet<VideoStatus> = new Set(["pending", "deferred"]);
const TERMINAL_FAIL: ReadonlySet<VideoStatus> = new Set(["abandoned", "failed", "failed_unsupported"]);

/** Decision for a stuck, non-archived candidate (queued/downloading/archived are
 *  filtered out before this is called). */
export function classifyCandidate(status: VideoStatus, videoExists: boolean): CandidateAction {
  if (!videoExists) return "skip";        // no source → not a gap
  if (HEALABLE.has(status)) return "requeue";
  if (TERMINAL_FAIL.has(status)) return "alert"; // real video, terminal failure
  return "skip";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: PASS — "all unit assertions passed."

- [ ] **Step 5: Commit**

```bash
git add lib/broadcasts/archive-reconciliation.ts scripts/test-archive-reconciliation-unit.ts
git commit -m "feat(broadcasts): classifyCandidate decision for archive reconciliation"
```

---

## Task 3: Pure fn `computeCoverage`

**Files:**
- Modify: `lib/broadcasts/archive-reconciliation.ts`
- Modify: `scripts/test-archive-reconciliation-unit.ts`

- [ ] **Step 1: Add failing test**

Append to `scripts/test-archive-reconciliation-unit.ts` (add the import to the existing import line):

```ts
import { classifyCandidate, computeCoverage } from "../lib/broadcasts/archive-reconciliation";
```

Append before the final `if (failures > 0)` block:

```ts
// --- computeCoverage ---
eq(
  computeCoverage([{ channel: "qvc", air_date: "2026-06-05", archived: 17, gapsWithVideo: 0 }]),
  [{ channel: "qvc", air_date: "2026-06-05", expected: 17, archived: 17, coverage: 100 }],
  "full coverage → 100",
);
eq(
  computeCoverage([{ channel: "shopch", air_date: "2026-06-05", archived: 24, gapsWithVideo: 1 }]),
  [{ channel: "shopch", air_date: "2026-06-05", expected: 25, archived: 24, coverage: 96 }],
  "1 gap of 25 → 96",
);
eq(
  computeCoverage([{ channel: "qvc", air_date: "2026-06-05", archived: 0, gapsWithVideo: 0 }]),
  [{ channel: "qvc", air_date: "2026-06-05", expected: 0, archived: 0, coverage: 100 }],
  "no expected → 100 (n/a)",
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: FAIL — `computeCoverage is not a function` (or import error)

- [ ] **Step 3: Implement**

Append to `lib/broadcasts/archive-reconciliation.ts`:

```ts
export interface DayTally { channel: string; air_date: string; archived: number; gapsWithVideo: number; }
export interface CoverageDay { channel: string; air_date: string; expected: number; archived: number; coverage: number; }

/** Coverage per (channel, air_date). expected = archived + video-exists gaps
 *  (no-source + in-flight already excluded by the caller). expected==0 → 100 (n/a). */
export function computeCoverage(tallies: DayTally[]): CoverageDay[] {
  return tallies.map((t) => {
    const expected = t.archived + t.gapsWithVideo;
    const coverage = expected === 0 ? 100 : Math.round((t.archived / expected) * 1000) / 10;
    return { channel: t.channel, air_date: t.air_date, expected, archived: t.archived, coverage };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/broadcasts/archive-reconciliation.ts scripts/test-archive-reconciliation-unit.ts
git commit -m "feat(broadcasts): computeCoverage for archive reconciliation"
```

---

## Task 4: Pure fn `selectAlertWorthy` + `GapRecord` type

**Files:**
- Modify: `lib/broadcasts/archive-reconciliation.ts`
- Modify: `scripts/test-archive-reconciliation-unit.ts`

- [ ] **Step 1: Add failing test**

Update the import line in `scripts/test-archive-reconciliation-unit.ts`:

```ts
import { classifyCandidate, computeCoverage, selectAlertWorthy, type GapRecord } from "../lib/broadcasts/archive-reconciliation";
```

Append before the final failure block:

```ts
// --- selectAlertWorthy ---
const gHealed: GapRecord = { broadcast_id: "a", channel: "shopch", air_date: "2026-06-01", start_time: "15:00:00", status: "deferred", classification: "healed", reason: "requeued" };
const gUnheal: GapRecord = { broadcast_id: "b", channel: "qvc", air_date: "2026-06-01", start_time: "20:00:00", status: "abandoned", classification: "unhealable", reason: "abandoned, video present" };
eq(selectAlertWorthy([gHealed, gUnheal], new Set()).map((g) => g.broadcast_id), ["b"], "first-seen healed excluded; unhealable alerts");
eq(selectAlertWorthy([gHealed], new Set(["a"])).map((g) => g.broadcast_id), ["a"], "healed gap persisting from previous run → alerts");
eq(selectAlertWorthy([gHealed], new Set()).map((g) => g.broadcast_id), [], "first-seen healed gap → no alert");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: FAIL — `selectAlertWorthy is not a function`

- [ ] **Step 3: Implement**

Append to `lib/broadcasts/archive-reconciliation.ts`:

```ts
export interface GapRecord {
  broadcast_id: string;
  channel: string;
  air_date: string;
  start_time: string;
  status: string;
  classification: "healed" | "unhealable";
  reason: string;
}

/** A gap is alert-worthy if it is a terminal failure with a real video
 *  (classification 'unhealable'), OR it was already a gap in the previous run
 *  (requeued last cycle but still not archived → not healing). */
export function selectAlertWorthy(gaps: GapRecord[], previousGapIds: Set<string>): GapRecord[] {
  return gaps.filter((g) => g.classification === "unhealable" || previousGapIds.has(g.broadcast_id));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/broadcasts/archive-reconciliation.ts scripts/test-archive-reconciliation-unit.ts
git commit -m "feat(broadcasts): selectAlertWorthy dedup for archive reconciliation"
```

---

## Task 5: Pure fn `buildWebhookPayload`

**Files:**
- Modify: `lib/broadcasts/archive-reconciliation.ts`
- Modify: `scripts/test-archive-reconciliation-unit.ts`

- [ ] **Step 1: Add failing test**

Update the import line:

```ts
import { classifyCandidate, computeCoverage, selectAlertWorthy, buildWebhookPayload, type GapRecord } from "../lib/broadcasts/archive-reconciliation";
```

Append before the final failure block:

```ts
// --- buildWebhookPayload ---
const payload = buildWebhookPayload(
  [gUnheal],
  [{ channel: "qvc", air_date: "2026-06-01", expected: 20, archived: 19, coverage: 95 }],
);
eq(payload.text === payload.content, true, "text and content identical (Slack+Discord)");
eq(payload.text.includes("1 un-healable gap"), true, "header counts gaps");
eq(payload.text.includes("[qvc] 2026-06-01 20:00:00"), true, "lists the gap");
eq(payload.text.includes("qvc 95% (19/20)"), true, "coverage summary present");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: FAIL — `buildWebhookPayload is not a function`

- [ ] **Step 3: Implement**

Append to `lib/broadcasts/archive-reconciliation.ts`:

```ts
/** Slack/Discord-compatible message body (text=Slack, content=Discord, identical). */
export function buildWebhookPayload(
  alertGaps: GapRecord[],
  coverage: CoverageDay[],
): { text: string; content: string } {
  const lines = [
    `🚨 Archive reconciliation — ${alertGaps.length} un-healable gap${alertGaps.length === 1 ? "" : "s"} (video exists, not archived)`,
  ];
  for (const g of alertGaps.slice(0, 20)) {
    lines.push(`  • [${g.channel}] ${g.air_date} ${g.start_time} — ${g.reason}`);
  }
  if (alertGaps.length > 20) lines.push(`  … and ${alertGaps.length - 20} more`);
  const byCh = new Map<string, { archived: number; expected: number }>();
  for (const c of coverage) {
    const e = byCh.get(c.channel) ?? { archived: 0, expected: 0 };
    e.archived += c.archived;
    e.expected += c.expected;
    byCh.set(c.channel, e);
  }
  const cov = [...byCh.entries()]
    .map(([ch, e]) => `${ch} ${e.expected === 0 ? 100 : Math.round((e.archived / e.expected) * 100)}% (${e.archived}/${e.expected})`)
    .join(" · ");
  lines.push(`Coverage (7d): ${cov}`);
  lines.push(`→ /admin/archive-status`);
  const msg = lines.join("\n");
  return { text: msg, content: msg };
}
```

> Note: the test's gap line asserts the channel/date/time prefix; `reason` for `gUnheal` is `"abandoned, video present"`, so the full line is `  • [qvc] 2026-06-01 20:00:00 — abandoned, video present`. The assertion checks the prefix substring, which is present.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/broadcasts/archive-reconciliation.ts scripts/test-archive-reconciliation-unit.ts
git commit -m "feat(broadcasts): buildWebhookPayload for archive reconciliation"
```

---

## Task 6: Generic `postWebhook` (`lib/alerts/webhook.ts`)

**Files:**
- Create: `lib/alerts/webhook.ts`
- Modify: `scripts/test-archive-reconciliation-unit.ts`

- [ ] **Step 1: Add failing test**

Add a second import near the top of `scripts/test-archive-reconciliation-unit.ts`:

```ts
import { postWebhook } from "../lib/alerts/webhook";
```

Append before the final failure block (note: top-level `await` works in tsx ESM):

```ts
// --- postWebhook ---
{
  const calls: Array<{ url: string; body: string }> = [];
  const okFetch = async (url: string, init: { body: string }) => { calls.push({ url, body: init.body }); return { ok: true, status: 200 }; };
  const r1 = await postWebhook("https://hook.test/x", { text: "hi" }, okFetch as never);
  eq(r1, { ok: true }, "postWebhook success");
  eq(calls.length === 1 && JSON.parse(calls[0].body).text === "hi", true, "posts JSON body");
  const badFetch = async () => ({ ok: false, status: 500 });
  const r2 = await postWebhook("https://hook.test/x", { text: "hi" }, badFetch as never);
  eq(r2.ok, false, "non-2xx → ok:false");
  const throwFetch = async () => { throw new Error("network down"); };
  const r3 = await postWebhook("https://hook.test/x", { text: "hi" }, throwFetch as never);
  eq(r3.ok === false && (r3.error ?? "").includes("network down"), true, "throw → ok:false with error");
}
```

Wrap the file body in an `async` IIFE if top-level await is not accepted by the tsx config — i.e., change the file to `async function main() { ... } main().then(() => { if (failures>0) process.exit(1); });`. **Implementer: if `npx tsx` errors on top-level await, refactor the whole unit file to a `main()` async wrapper (move the final failure block inside, call `main()`).**

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: FAIL — `Cannot find module '../lib/alerts/webhook'`

- [ ] **Step 3: Implement**

Create `lib/alerts/webhook.ts`:

```ts
/**
 * Generic webhook POST for ops alerts. Slack/Discord compatible — the caller
 * builds the body. NO `import "server-only"` — used by tsx smoke scripts.
 */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export async function postWebhook(
  url: string,
  body: object,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `webhook HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts`
Expected: PASS — all unit assertions

- [ ] **Step 5: Commit**

```bash
git add lib/alerts/webhook.ts scripts/test-archive-reconciliation-unit.ts
git commit -m "feat(alerts): generic postWebhook sender"
```

---

## Task 7: Orchestrator `reconcileArchiveCoverage` + probe + live test

**Files:**
- Modify: `lib/broadcasts/archive-reconciliation.ts`
- Create: `scripts/test-archive-reconciliation.ts`

- [ ] **Step 1: Write the failing live test**

Create `scripts/test-archive-reconciliation.ts`:

```ts
/**
 * Live-DB test for reconcileArchiveCoverage (self-cleaning, no network).
 *   npx tsx --env-file=.env.local scripts/test-archive-reconciliation.ts
 * Injected whitelist + stubbed probe + stubbed webhook → deterministic, no prod mutation
 * beyond sentinel rows. Skip-guards if archive_reconciliation_runs table is absent.
 */
import { getServiceClient } from "../lib/supabase";
import { reconcileArchiveCoverage, type ReconcileSlot } from "../lib/broadcasts/archive-reconciliation";

const PAST = "2020-01-02"; // strictly past, older than real data
const CH = "shopch";
const WL = "TESTWL";
const whitelist = new Map<string, Set<string>>([["shopch", new Set([WL])], ["qvc", new Set([WL])]]);

let failures = 0;
function ok(c: boolean, m: string) { if (c) console.log(`  ok: ${m}`); else { console.error(`  FAIL: ${m}`); failures++; } }

async function main() {
  const sb = getServiceClient();

  // skip-guard: table must exist
  const probe = await sb.from("archive_reconciliation_runs").select("id").limit(1);
  if (probe.error && /relation .* does not exist/i.test(probe.error.message)) {
    console.log("SKIP: archive_reconciliation_runs table not present (apply migration first).");
    return;
  }

  async function cleanup() {
    await sb.from("broadcasts").delete().eq("channel", CH).eq("air_date", PAST);
  }
  await cleanup();

  // sentinels: video+pending→heal, video+abandoned→alert, no-video+pending→skip, archived→untouched
  const rows = [
    { start_time: "00:00:00", category: WL, video_status: "pending",  archived_video_s3: null,        title: "S-video-pending" },
    { start_time: "01:00:00", category: WL, video_status: "abandoned", archived_video_s3: null,        title: "S-video-abandoned" },
    { start_time: "02:00:00", category: WL, video_status: "pending",  archived_video_s3: null,        title: "S-novideo-pending" },
    { start_time: "03:00:00", category: WL, video_status: "archived", archived_video_s3: "k/abc.mp4", title: "S-archived" },
    { start_time: "04:00:00", category: WL, video_status: "queued",   archived_video_s3: null,        title: "S-inflight" },
  ];
  const { error: insErr } = await sb.from("broadcasts").insert(rows.map((r) => ({
    channel: CH, air_date: PAST, start_time: r.start_time, category: r.category,
    program_title: r.title, video_status: r.video_status, archived_video_s3: r.archived_video_s3,
    source_url: `https://test.invalid/recon/${r.start_time}`,
  })));
  if (insErr) { console.error("setup insert failed:", insErr.message); process.exit(1); }

  // stub probe: video exists for all sentinels EXCEPT the 02:00 "no-video" one.
  const stubProbe = async (slot: ReconcileSlot) => slot.start_time !== "02:00:00";
  const sentWebhook: object[] = [];
  const stubWebhook = async (_url: string, body: object) => { sentWebhook.push(body); return { ok: true }; };

  const result = await reconcileArchiveCoverage({
    lookbackDays: 99999, whitelist, probeVideo: stubProbe,
    webhookUrl: "https://hook.test/x", postWebhook: stubWebhook,
    now: new Date("2020-01-09T00:00:00Z"), // PAST is within window and < today(2020-01-09)
  });

  // statuses after run
  const { data: after } = await sb.from("broadcasts").select("start_time, video_status").eq("channel", CH).eq("air_date", PAST);
  const st = (t: string) => (after ?? []).find((r) => r.start_time === t)?.video_status;
  ok(st("00:00:00") === "queued", "video+pending → requeued to queued");
  ok(st("01:00:00") === "abandoned", "video+abandoned → left (alert, no resurrect)");
  ok(st("02:00:00") === "pending", "no-video+pending → untouched (skip)");
  ok(st("03:00:00") === "archived", "archived → untouched");
  ok(st("04:00:00") === "queued", "in-flight queued → untouched (not probed)");
  ok(result.healed >= 1, "result.healed counts the requeue");
  ok(result.unhealable >= 1, "result.unhealable counts the abandoned-with-video");
  ok(result.no_source >= 1, "result.no_source counts the no-video candidate");
  ok(result.alerted === true && sentWebhook.length === 1, "first run alerts (unhealable present)");

  // a run row was recorded
  const { data: runs } = await sb.from("archive_reconciliation_runs").select("id, unhealable").order("ran_at", { ascending: false }).limit(1);
  ok((runs ?? []).length === 1 && (runs![0] as { unhealable: number }).unhealable >= 1, "run row persisted with unhealable count");

  await cleanup();
  if (failures > 0) { console.error(`\n${failures} failed.`); process.exit(1); }
  console.log("\nall live assertions passed.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --env-file=.env.local scripts/test-archive-reconciliation.ts`
Expected: FAIL — `reconcileArchiveCoverage is not exported` (or compile error). (If it prints `SKIP`, apply the migration first, then it should fail on the missing export.)

- [ ] **Step 3: Implement the orchestrator + probe**

Append to `lib/broadcasts/archive-reconciliation.ts`:

```ts
import { getServiceClient } from "@/lib/supabase";
import { loadWhitelist, isAllowed } from "./category-filter";
import { buildProgramId } from "./shopch-json";

export interface ReconcileSlot {
  id: string;
  channel: "qvc" | "shopch";
  air_date: string;
  start_time: string;
  program_title: string | null;
  category: string | null;
  product_ids: string[] | null;
  video_status: VideoStatus;
  archived_video_s3: string | null;
  video_download_attempts: number | null;
}

export interface ReconcileResult {
  window_from: string;
  window_to: string;
  expected_total: number;
  archived_total: number;
  coverage_pct: number;
  healed: number;
  unhealable: number;
  no_source: number;
  probed: number;
  coverage_by_day: CoverageDay[];
  gaps: GapRecord[];
  alerted: boolean;
  alert_error: string | null;
}

type ProbeFn = (slot: ReconcileSlot) => Promise<boolean>;
type WebhookFn = (url: string, body: object) => Promise<{ ok: boolean; error?: string }>;

export interface ReconcileOptions {
  lookbackDays?: number;
  whitelist?: Map<string, Set<string>>;
  probeVideo?: ProbeFn;
  postWebhook?: WebhookFn;
  webhookUrl?: string;
  now?: Date;
}

const STUCK: ReadonlySet<VideoStatus> = new Set(["pending", "deferred", "abandoned", "failed", "failed_unsupported"]);
const PAGE = 1000;

function jstDate(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + 9 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Default probe: QVC = lead product video_url present (DB); ShopCh = m3u8 200/206 (HTTP). */
export async function defaultProbeVideo(slot: ReconcileSlot): Promise<boolean> {
  if (slot.channel === "qvc") {
    const pid = slot.product_ids?.[0];
    if (!pid) return false;
    const sb = getServiceClient();
    const { data } = await sb.from("qvc_products").select("video_url").eq("id", pid).maybeSingle();
    return !!(data as { video_url: string | null } | null)?.video_url;
  }
  const programId = buildProgramId(slot.air_date, slot.start_time);
  const url = `https://www.shopch.jp/m3u8/prog/${programId}/${programId}_jwplayer.m3u8`;
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
    return res.status === 200 || res.status === 206;
  } catch {
    return false;
  }
}

async function loadPreviousGapIds(sb: ReturnType<typeof getServiceClient>): Promise<Set<string>> {
  const { data } = await sb
    .from("archive_reconciliation_runs")
    .select("gaps")
    .order("ran_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0] as { gaps: GapRecord[] } | undefined;
  return new Set((row?.gaps ?? []).map((g) => g.broadcast_id));
}

export async function reconcileArchiveCoverage(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const sb = getServiceClient();
  const now = opts?.now ?? new Date();
  const lookbackDays = opts?.lookbackDays ?? (Number(process.env.RECONCILE_LOOKBACK_DAYS) || 7);
  const whitelist = opts?.whitelist ?? (await loadWhitelist());
  const probeVideo = opts?.probeVideo ?? defaultProbeVideo;
  const postWebhookFn = opts?.postWebhook;
  const webhookUrl = opts?.webhookUrl ?? process.env.ALERT_WEBHOOK_URL ?? "";

  const window_to = jstDate(now, 0);      // exclusive (today)
  const window_from = jstDate(now, -lookbackDays);

  // load whitelist slots in window
  const slots: ReconcileSlot[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await sb
      .from("broadcasts")
      .select("id, channel, air_date, start_time, program_title, category, product_ids, video_status, archived_video_s3, video_download_attempts")
      .in("channel", ["qvc", "shopch"])
      .gte("air_date", window_from)
      .lt("air_date", window_to)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`[reconcile] load failed: ${error.message}`);
    const batch = (data ?? []) as ReconcileSlot[];
    slots.push(...batch.filter((s) => isAllowed(whitelist, s.channel, s.category)));
    if (batch.length < PAGE) break;
    offset += PAGE;
  }

  // per-day tallies + gaps
  const tallyKey = (s: ReconcileSlot) => `${s.channel}|${s.air_date}`;
  const archivedByDay = new Map<string, number>();
  const gapsByDay = new Map<string, number>();
  const gaps: GapRecord[] = [];
  let healed = 0, unhealable = 0, no_source = 0, probed = 0;

  for (const s of slots) {
    const k = tallyKey(s);
    if (s.archived_video_s3 || s.video_status === "archived") {
      archivedByDay.set(k, (archivedByDay.get(k) ?? 0) + 1);
      continue;
    }
    if (!STUCK.has(s.video_status)) continue; // queued/downloading → in-flight, skip
    probed++;
    const hasVideo = await probeVideo(s);
    const action = classifyCandidate(s.video_status, hasVideo);
    if (action === "skip") { no_source++; continue; } // no source video
    gapsByDay.set(k, (gapsByDay.get(k) ?? 0) + 1);
    if (action === "requeue") {
      const { data: upd } = await sb
        .from("broadcasts")
        .update({ video_status: "queued", video_error: null })
        .eq("id", s.id)
        .in("video_status", ["pending", "deferred"]) // CAS
        .select("id");
      if (upd && upd.length > 0) healed++;
      gaps.push({ broadcast_id: s.id, channel: s.channel, air_date: s.air_date, start_time: s.start_time, status: s.video_status, classification: "healed", reason: "requeued (video present)" });
    } else { // alert
      unhealable++;
      gaps.push({ broadcast_id: s.id, channel: s.channel, air_date: s.air_date, start_time: s.start_time, status: s.video_status, classification: "unhealable", reason: `${s.video_status}, video present` });
    }
  }

  // coverage
  const dayKeys = new Set<string>([...archivedByDay.keys(), ...gapsByDay.keys()]);
  const tallies: DayTally[] = [...dayKeys].map((k) => {
    const [channel, air_date] = k.split("|");
    return { channel, air_date, archived: archivedByDay.get(k) ?? 0, gapsWithVideo: gapsByDay.get(k) ?? 0 };
  });
  const coverage_by_day = computeCoverage(tallies).sort((a, b) => (a.air_date + a.channel).localeCompare(b.air_date + b.channel));
  const expected_total = coverage_by_day.reduce((n, c) => n + c.expected, 0);
  const archived_total = coverage_by_day.reduce((n, c) => n + c.archived, 0);
  const coverage_pct = expected_total === 0 ? 100 : Math.round((archived_total / expected_total) * 10000) / 100;

  // alert
  const prevGapIds = await loadPreviousGapIds(sb);
  const alertGaps = selectAlertWorthy(gaps, prevGapIds);
  let alerted = false;
  let alert_error: string | null = null;
  if (alertGaps.length > 0 && webhookUrl) {
    const sender = postWebhookFn ?? (await import("@/lib/alerts/webhook")).postWebhook;
    const body = buildWebhookPayload(alertGaps, coverage_by_day);
    const r = await sender(webhookUrl, body);
    alerted = r.ok;
    alert_error = r.ok ? null : (r.error ?? "unknown webhook error");
  }

  const result: ReconcileResult = {
    window_from, window_to, expected_total, archived_total, coverage_pct,
    healed, unhealable, no_source, probed, coverage_by_day, gaps, alerted, alert_error,
  };

  // persist
  const { error: insErr } = await sb.from("archive_reconciliation_runs").insert({
    ran_at: now.toISOString(),
    window_from, window_to, channels: ["qvc", "shopch"],
    expected_total, archived_total, coverage_pct,
    healed, unhealable, no_source, probed,
    coverage_by_day, gaps, alerted, alert_error,
  });
  if (insErr) console.warn("[reconcile] run insert failed:", insErr.message);

  return result;
}
```

- [ ] **Step 4: Run to verify it passes**

First ensure the migration is applied (operator). Then run:
`npx tsx --env-file=.env.local scripts/test-archive-reconciliation.ts`
Expected: PASS — "all live assertions passed." (If it prints `SKIP`, apply the migration and re-run.)

- [ ] **Step 5: Run unit tests + tsc to confirm no regressions**

Run: `npx tsx scripts/test-archive-reconciliation-unit.ts && npx tsc --noEmit`
Expected: unit PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/broadcasts/archive-reconciliation.ts scripts/test-archive-reconciliation.ts
git commit -m "feat(broadcasts): reconcileArchiveCoverage orchestrator + live test"
```

---

## Task 8: Cron route

**Files:**
- Create: `app/api/cron/archive-reconciliation/route.ts`

- [ ] **Step 1: Implement the route** (no unit test — thin wrapper; verified by the manual smoke in Task 11)

Create `app/api/cron/archive-reconciliation/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { reconcileArchiveCoverage } from "@/lib/broadcasts/archive-reconciliation";

export const maxDuration = 120;

function verifyCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const result = await reconcileArchiveCoverage();
    const out = { ...result, duration_ms: Date.now() - startedAt };
    console.log("[archive-reconciliation]", JSON.stringify(out));
    return NextResponse.json(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[archive-reconciliation] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/archive-reconciliation/route.ts
git commit -m "feat(broadcasts): archive-reconciliation cron route"
```

---

## Task 9: Admin dashboard coverage panel

**Files:**
- Modify: `app/[locale]/(admin)/admin/archive-status/page.tsx`

- [ ] **Step 1: Add the coverage panel**

In `app/[locale]/(admin)/admin/archive-status/page.tsx`, after the existing `const { data: sizes } = ...` block (before the `return (`), add a fetch of the latest reconciliation run:

```tsx
	const { data: latestRun } = await sb
		.from("archive_reconciliation_runs")
		.select("ran_at, coverage_pct, healed, unhealable, no_source, coverage_by_day, gaps")
		.order("ran_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	const run = latestRun as null | {
		ran_at: string; coverage_pct: number; healed: number; unhealable: number; no_source: number;
		coverage_by_day: { channel: string; air_date: string; expected: number; archived: number; coverage: number }[];
		gaps: { channel: string; air_date: string; start_time: string; status: string; classification: string; reason: string }[];
	};
	const redAt = Number(process.env.RECONCILE_COVERAGE_RED ?? 90);
	const amberAt = Number(process.env.RECONCILE_COVERAGE_AMBER ?? 98);
	const gateColor = (c: number) => (c < redAt ? "#dc2626" : c < amberAt ? "#d97706" : "#16a34a");
```

Then, immediately inside the top of the returned `<div className="max-w-5xl mx-auto p-6">` (after the `<h1>`), add:

```tsx
				{run && (
					<section className="mb-8 border rounded p-4">
						<h2 className="text-lg font-semibold mb-2">
							Coverage reconciliation <span className="text-xs text-muted-foreground">({new Date(run.ran_at).toLocaleString("ja-JP")})</span>
						</h2>
						<div className="flex gap-4 mb-3 text-sm">
							<span>overall <b style={{ color: gateColor(run.coverage_pct) }}>{run.coverage_pct}%</b></span>
							<span>healed {run.healed}</span>
							<span className={run.unhealable > 0 ? "text-red-600 font-semibold" : ""}>un-healable {run.unhealable}</span>
							<span className="text-muted-foreground">no-source {run.no_source}</span>
						</div>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-2">
							{(run.coverage_by_day ?? []).map((c) => (
								<div key={`${c.channel}-${c.air_date}`} className="border rounded px-2 py-1 text-xs">
									<div className="text-muted-foreground">{c.channel} {c.air_date}</div>
									<div style={{ color: gateColor(c.coverage) }} className="font-semibold">{c.coverage}% ({c.archived}/{c.expected})</div>
								</div>
							))}
						</div>
						{run.unhealable > 0 && (
							<ul className="mt-3 text-xs text-red-700 list-disc pl-5">
								{(run.gaps ?? []).filter((g) => g.classification === "unhealable").map((g, i) => (
									<li key={i}>[{g.channel}] {g.air_date} {g.start_time} — {g.reason}</li>
								))}
							</ul>
						)}
					</section>
				)}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add "app/[locale]/(admin)/admin/archive-status/page.tsx"
git commit -m "feat(admin): coverage reconciliation panel on archive-status"
```

---

## Task 10: Manual runner script

**Files:**
- Create: `scripts/reconcile-archive.ts`

- [ ] **Step 1: Implement the runner**

Create `scripts/reconcile-archive.ts`:

```ts
/**
 * Manual archive reconciliation — same logic the daily cron runs.
 *   npx tsx --env-file=.env.local scripts/reconcile-archive.ts [lookbackDays]
 */
import { reconcileArchiveCoverage } from "../lib/broadcasts/archive-reconciliation";

async function main() {
  const lookbackDays = Number(process.argv[2]) || undefined;
  const r = await reconcileArchiveCoverage({ lookbackDays });
  console.log(JSON.stringify(r, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/reconcile-archive.ts
git commit -m "feat(broadcasts): manual archive reconciliation runner"
```

---

## Task 11: Wire cron + npm aliases, final verification

**Files:**
- Modify: `vercel.json`
- Modify: `package.json`

- [ ] **Step 1: Add the cron + maxDuration to `vercel.json`**

In `vercel.json`, add to the `functions` map (near the other cron entries):

```json
    "app/api/cron/archive-reconciliation/route.ts": {
      "maxDuration": 120
    },
```

And add to the `crons` array:

```json
    {
      "path": "/api/cron/archive-reconciliation",
      "schedule": "0 21 * * *"
    },
```

- [ ] **Step 2: Add npm aliases to `package.json`**

Add to `scripts` (near `recover:shopch-pending`):

```json
    "reconcile:archive": "tsx --env-file=.env.local scripts/reconcile-archive.ts",
    "test:archive-reconciliation-unit": "tsx scripts/test-archive-reconciliation-unit.ts",
    "test:archive-reconciliation": "tsx --env-file=.env.local scripts/test-archive-reconciliation.ts",
```

- [ ] **Step 3: Validate JSON + types**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('json ok')"`
Expected: `json ok`
Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the full test suite**

Run: `npm run test:archive-reconciliation-unit`
Expected: "all unit assertions passed."
Run (requires migration applied + `.env.local`): `npm run test:archive-reconciliation`
Expected: "all live assertions passed." (or `SKIP` if migration not yet applied — then apply and re-run.)

- [ ] **Step 5: Manual smoke against the real DB (read-mostly)**

Run: `npm run reconcile:archive`
Expected: a JSON result. With the current drained backlog, expect `healed: 0`, `unhealable: 0` (or small), `no_source` small, and `coverage_pct` near 100. Confirm a row appears: re-run and check `/admin/archive-status` shows the coverage panel.

- [ ] **Step 6: Commit**

```bash
git add vercel.json package.json
git commit -m "chore(broadcasts): wire archive-reconciliation cron + npm aliases"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §4 architecture → Tasks 2–11. §5 algorithm → Task 7 (orchestrator) + Tasks 2–4 (pure fns). §6 table → Task 1. §7 webhook → Tasks 5–6. §8 cron → Task 8 + Task 11. §9 dashboard → Task 9. §10 env vars → read in Task 7 (`RECONCILE_LOOKBACK_DAYS`, `ALERT_WEBHOOK_URL`), Task 9 (`RECONCILE_COVERAGE_RED/_AMBER`), Task 7 default probe concurrency is currently sequential — see note below. §11 testing → unit (Tasks 2–6) + live (Task 7). §12/13 out-of-scope/limitations → not implemented (correct).
- **Gap found & accepted:** `RECONCILE_PROBE_CONCURRENCY` (spec §10) is not used — the orchestrator probes candidates sequentially. Candidates are few (only stuck, non-archived slots), so sequential is acceptable for the MVP; concurrency is a trivial future optimization. Documented here rather than adding an unused knob.

**Placeholder scan:** none — every step has complete code/commands.

**Type consistency:** `ReconcileSlot`, `GapRecord`, `CoverageDay`, `DayTally`, `CandidateAction`, `VideoStatus` defined in `archive-reconciliation.ts` and used consistently across orchestrator, tests, and dashboard. `postWebhook(url, body, fetchImpl?)` signature matches its call in the orchestrator (`sender(webhookUrl, body)`) and the unit test. `classifyCandidate`/`computeCoverage`/`selectAlertWorthy`/`buildWebhookPayload` names consistent between definition, unit test, and orchestrator.

**Decision note:** the orchestrator imports `postWebhook` lazily (`await import("@/lib/alerts/webhook")`) only when no `postWebhook` is injected, so the live test's stub fully avoids network and the lazy import is never hit in tests.
