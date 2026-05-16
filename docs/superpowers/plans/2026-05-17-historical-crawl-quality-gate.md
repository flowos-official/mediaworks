# Historical Crawl Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add observability to the 8-channel daily historical-broadcasts cron so we can detect parser regressions, dead channels, or dropped data **before** building downstream features (category filtering, AI competitive analysis) on top of it.

**Architecture:** A new `historical_crawl_runs` table logs each cron execution with per-channel breakdown (status, row count, error, duration). An admin-only API + UI page surfaces recent runs and per-channel 7-day baselines, flagging anomalies (run failure, row-count drop ≥50% vs 7d median) so an operator can act before the data pipe silently rots.

**Tech Stack:** Next.js App Router (Server Components), Supabase (Postgres + RLS), TypeScript, existing `requireUser` / `route-permissions` patterns. No new dependencies.

---

## Context an engineer needs

- The crawler entry point is `lib/historical-crawl/index.ts::crawlAll(jstDate)`. It runs 8 parsers via `Promise.allSettled` and returns `{ jstDate, results: CrawlResult[], persist, totalRows }` where each `CrawlResult` has `{ channel, ok, rows, error?, durationMs }`.
- The cron route is `app/api/cron/daily-historical-broadcasts/route.ts`. It already calls `crawlAll` and logs a JSON summary to `console.log`. Logs are not queryable from the app.
- Auth pattern: every user-initiated API route calls `await requireUser(["admin"])` (or wider role set) at the top, returns `auth.sb` for queries to respect RLS. `getServiceClient()` is reserved for cron / workflow.
- RLS pattern: see `supabase/migrations/2026-05-13_auth_rls_tight.sql` and `_loose.sql`. Group B (internal) tables get `member`/`admin` policies; new admin-only run logs can be `admin`-only.
- Admin pages live under `app/[locale]/admin/`. Existing examples: `admin/users/page.tsx`, `admin/registry/[skillSlug]/page.tsx`. Server components do auth + initial fetch; client components handle interactivity. The proxy already routes `/admin/*` to admin role only via `isViewerAllowedPath()`.
- `discovery_runs` (in `supabase/migrations/2026-04-18_discovery_system.sql`) is the closest existing pattern. We model `historical_crawl_runs` after it.

## File Structure

**Create:**
- `supabase/migrations/2026-05-17_historical_crawl_runs.sql` — table + RLS + indexes
- `lib/historical-crawl/runs.ts` — `startRun()` / `finalizeRun()` / `loadBaseline()` helpers
- `app/api/historical-broadcasts/runs/route.ts` — `GET` admin API returning recent runs + baselines
- `app/[locale]/admin/historical-crawl/page.tsx` — server component, auth gate + initial fetch
- `components/admin/HistoricalCrawlDashboard.tsx` — client component, table + anomaly badges

**Modify:**
- `app/api/cron/daily-historical-broadcasts/route.ts` — call `startRun` / `finalizeRun` around `crawlAll`
- `components/Navbar.tsx` — add link to `/admin/historical-crawl` for admin role
- `messages/ja.json` — `admin.historicalCrawl.*` keys
- `messages/ko.json` — same keys, Korean
- `CLAUDE.md` — append observability note to the Broadcast Calendar section

**No changes needed:** `proxy.ts` (admin routes already gated), `lib/auth/route-permissions.ts` (admin role already covers `/admin/*`).

---

## Task 1: Migration — historical_crawl_runs table

**Files:**
- Create: `supabase/migrations/2026-05-17_historical_crawl_runs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Observability for the 8-channel daily-historical-broadcasts cron.
-- One row per cron execution, with per-channel breakdown in `channels` jsonb.

CREATE TABLE IF NOT EXISTS historical_crawl_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at          timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  jst_date        date NOT NULL,
  status          text NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  total_rows      int NOT NULL DEFAULT 0,
  upserted        int NOT NULL DEFAULT 0,
  skipped_dup     int NOT NULL DEFAULT 0,
  channels        jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms     int,
  error           text
);

CREATE INDEX IF NOT EXISTS idx_hcr_run_at ON historical_crawl_runs (run_at DESC);
CREATE INDEX IF NOT EXISTS idx_hcr_jst_date ON historical_crawl_runs (jst_date DESC);

ALTER TABLE historical_crawl_runs ENABLE ROW LEVEL SECURITY;

-- Admin-only: this is operational telemetry, not business data.
DROP POLICY IF EXISTS admin_all ON historical_crawl_runs;
CREATE POLICY admin_all ON historical_crawl_runs
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );
```

The `channels` jsonb field stores an array shaped `[{ channel, ok, rowCount, error?, durationMs }]` — flexible enough to grow without schema churn, narrow enough to be queryable per-channel.

- [ ] **Step 2: Apply locally**

Open the Supabase dashboard SQL editor (or use `supabase db push` if CLI is wired) and paste the SQL. Verify:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'historical_crawl_runs' ORDER BY ordinal_position;
```

Expected: 10 rows matching the column list above. RLS verification:

```sql
SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'historical_crawl_runs'::regclass;
```

Expected: one row with `admin_all`, `*` (FOR ALL).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-05-17_historical_crawl_runs.sql
git commit -m "feat(observability): historical_crawl_runs table + admin RLS"
```

---

## Task 2: Run-logging helpers

**Files:**
- Create: `lib/historical-crawl/runs.ts`

- [ ] **Step 1: Define interfaces and `startRun`**

Write `lib/historical-crawl/runs.ts`:

```ts
import { getServiceClient } from "@/lib/supabase";

export interface PerChannelRunEntry {
  channel: string;
  ok: boolean;
  rowCount: number;
  durationMs: number;
  error?: string;
}

export type RunStatus = "running" | "completed" | "partial" | "failed";

/**
 * Insert a row with status='running' and return its id.
 * The cron path uses the service client (non-user-initiated).
 */
export async function startRun(jstDate: string): Promise<string> {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("historical_crawl_runs")
    .insert({ jst_date: jstDate, status: "running" as RunStatus })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`startRun failed: ${error?.message ?? "unknown"}`);
  }
  return data.id as string;
}

export interface FinalizeRunInput {
  runId: string;
  status: RunStatus;
  totalRows: number;
  upserted: number;
  skippedDup: number;
  channels: PerChannelRunEntry[];
  durationMs: number;
  error?: string;
}

/**
 * Update the run row with final counts. Best-effort: a logging failure
 * must not propagate and break the cron itself.
 */
export async function finalizeRun(input: FinalizeRunInput): Promise<void> {
  const sb = getServiceClient();
  const { error } = await sb
    .from("historical_crawl_runs")
    .update({
      status: input.status,
      total_rows: input.totalRows,
      upserted: input.upserted,
      skipped_dup: input.skippedDup,
      channels: input.channels,
      duration_ms: input.durationMs,
      error: input.error ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", input.runId);
  if (error) {
    console.warn("[historical-crawl-runs] finalizeRun failed:", error.message);
  }
}
```

- [ ] **Step 2: Define `loadBaseline` (per-channel 7-day median row count)**

Append to `runs.ts`:

```ts
export interface ChannelBaseline {
  channel: string;
  median7d: number; // median row count over last 7 successful runs
  samples: number; // how many runs contributed
}

/**
 * Median row count per channel over the most recent `lookbackDays` of
 * completed/partial runs. Used by the admin UI to flag anomalies
 * (current run row count < 50% of median).
 */
export async function loadBaseline(lookbackDays = 7): Promise<ChannelBaseline[]> {
  const sb = getServiceClient();
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString();
  const { data, error } = await sb
    .from("historical_crawl_runs")
    .select("channels")
    .gte("run_at", cutoff)
    .in("status", ["completed", "partial"]);
  if (error || !data) return [];

  const byChannel = new Map<string, number[]>();
  for (const row of data) {
    const channels = (row as { channels: PerChannelRunEntry[] }).channels ?? [];
    for (const c of channels) {
      const arr = byChannel.get(c.channel) ?? [];
      arr.push(c.rowCount);
      byChannel.set(c.channel, arr);
    }
  }

  const out: ChannelBaseline[] = [];
  for (const [channel, counts] of byChannel) {
    const sorted = [...counts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
    out.push({ channel, median7d: median, samples: sorted.length });
  }
  return out;
}
```

- [ ] **Step 3: Manual smoke test**

Create a one-off script `scripts/smoke-historical-crawl-runs.ts`:

```ts
import { startRun, finalizeRun, loadBaseline } from "../lib/historical-crawl/runs";

(async () => {
  const id = await startRun("2026-05-17");
  console.log("startRun id:", id);
  await finalizeRun({
    runId: id,
    status: "completed",
    totalRows: 100,
    upserted: 90,
    skippedDup: 10,
    channels: [
      { channel: "ntv", ok: true, rowCount: 50, durationMs: 400 },
      { channel: "tbs", ok: true, rowCount: 50, durationMs: 500 },
    ],
    durationMs: 950,
  });
  const baseline = await loadBaseline(7);
  console.log("baseline:", baseline);
})();
```

Run: `npx tsx --env-file=.env.local scripts/smoke-historical-crawl-runs.ts`

Expected: prints a uuid, then a baseline array containing ntv/tbs with `median7d`>0. Verify in DB:

```sql
SELECT id, status, total_rows, channels FROM historical_crawl_runs
ORDER BY run_at DESC LIMIT 1;
```

Then delete the smoke script (it's one-time): `rm scripts/smoke-historical-crawl-runs.ts`.

- [ ] **Step 4: Commit**

```bash
git add lib/historical-crawl/runs.ts
git commit -m "feat(observability): startRun/finalizeRun/loadBaseline helpers"
```

---

## Task 3: Wire run logging into the cron

**Files:**
- Modify: `app/api/cron/daily-historical-broadcasts/route.ts`

- [ ] **Step 1: Replace the cron handler body**

Current body assigns `summary = await crawlAll(date)`. Wrap it with `startRun` / `finalizeRun` and translate the per-channel results into `PerChannelRunEntry[]`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { crawlAll } from "@/lib/historical-crawl";
import { jstToday } from "@/lib/historical-crawl/types";
import {
  finalizeRun,
  startRun,
  type PerChannelRunEntry,
  type RunStatus,
} from "@/lib/historical-crawl/runs";

export const maxDuration = 300;

function verifyCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  const header = req.headers.get("authorization");
  return header === "Bearer " + secret;
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const start = Date.now();
  const date = jstToday();
  const runId = await startRun(date);

  try {
    const summary = await crawlAll(date);
    const channels: PerChannelRunEntry[] = summary.results.map((r) => ({
      channel: r.channel,
      ok: r.ok,
      rowCount: r.rows.length,
      durationMs: r.durationMs,
      ...(r.error ? { error: r.error } : {}),
    }));

    const status: RunStatus =
      summary.results.every((r) => r.ok)
        ? "completed"
        : summary.results.some((r) => r.ok)
          ? "partial"
          : "failed";

    await finalizeRun({
      runId,
      status,
      totalRows: summary.totalRows,
      upserted: summary.persist.upserted,
      skippedDup: summary.persist.skippedDuplicate,
      channels,
      durationMs: Date.now() - start,
    });

    return NextResponse.json({
      ok: true,
      runId,
      status,
      jstDate: date,
      totalRows: summary.totalRows,
      upserted: summary.persist.upserted,
      skippedDuplicate: summary.persist.skippedDuplicate,
      channels,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finalizeRun({
      runId,
      status: "failed",
      totalRows: 0,
      upserted: 0,
      skippedDup: 0,
      channels: [],
      durationMs: Date.now() - start,
      error: msg.slice(0, 500),
    });
    return NextResponse.json(
      { ok: false, runId, error: msg },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Trigger locally and verify**

Start dev server: `npm run dev`. In another terminal:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/daily-historical-broadcasts
```

(If `CRON_SECRET` is unset locally, the route auths-through.)

Verify response contains `runId`, `status: 'completed'`, non-zero `totalRows`. In Supabase:

```sql
SELECT id, status, total_rows, upserted, channels, duration_ms, error
FROM historical_crawl_runs
ORDER BY run_at DESC LIMIT 1;
```

Expected: row with status `completed`, total_rows matching the curl response, channels array of 8 entries.

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/daily-historical-broadcasts/route.ts
git commit -m "feat(observability): log each historical-crawl run to DB"
```

---

## Task 4: GET API for runs + baselines

**Files:**
- Create: `app/api/historical-broadcasts/runs/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { requireUser } from "@/lib/auth/require-user";
import { type NextRequest, NextResponse } from "next/server";
import { loadBaseline } from "@/lib/historical-crawl/runs";

const INT_PARAM = /^\d+$/;

export async function GET(req: NextRequest) {
  // Admin-only — operational telemetry.
  const auth = await requireUser(["admin"]);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(req.url);
  const limitRaw = searchParams.get("limit");
  if (limitRaw !== null && !INT_PARAM.test(limitRaw)) {
    return NextResponse.json({ error: "invalid limit" }, { status: 400 });
  }
  const limit = Math.min(limitRaw === null ? 30 : parseInt(limitRaw, 10), 100);

  const { data: runs, error } = await auth.sb
    .from("historical_crawl_runs")
    .select(
      "id,run_at,completed_at,jst_date,status,total_rows,upserted,skipped_dup,channels,duration_ms,error",
    )
    .order("run_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[historical-broadcasts/runs] list error", error);
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }

  const baseline = await loadBaseline(7);

  return NextResponse.json(
    { runs: runs ?? [], baseline },
    {
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
      },
    },
  );
}
```

Note: uses `auth.sb` (RLS-respecting server client), `private` cache, `INT_PARAM` validation — all matching the conventions hardened in PR #35.

- [ ] **Step 2: Smoke test**

Sign in as an admin in the dev environment, then:

```bash
curl -b "<cookie>" http://localhost:3000/api/historical-broadcasts/runs?limit=5
```

Expected: JSON `{ runs: [...], baseline: [...] }`. As a non-admin user, expect `403`.

- [ ] **Step 3: Commit**

```bash
git add app/api/historical-broadcasts/runs/route.ts
git commit -m "feat(observability): /api/historical-broadcasts/runs admin endpoint"
```

---

## Task 5: Dashboard client component

**Files:**
- Create: `components/admin/HistoricalCrawlDashboard.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ChannelBaseline, PerChannelRunEntry } from "@/lib/historical-crawl/runs";

interface RunRow {
  id: string;
  run_at: string;
  completed_at: string | null;
  jst_date: string;
  status: "running" | "completed" | "partial" | "failed";
  total_rows: number;
  upserted: number;
  skipped_dup: number;
  channels: PerChannelRunEntry[];
  duration_ms: number | null;
  error: string | null;
}

interface Props {
  initialRuns: RunRow[];
  baseline: ChannelBaseline[];
}

function ratio(actual: number, median: number): number {
  if (median <= 0) return 1;
  return actual / median;
}

function anomalyClass(r: number): string {
  if (r < 0.5) return "bg-red-100 text-red-700";
  if (r < 0.8) return "bg-amber-100 text-amber-700";
  return "bg-green-100 text-green-700";
}

export default function HistoricalCrawlDashboard({ initialRuns, baseline }: Props) {
  const t = useTranslations("admin.historicalCrawl");
  const [expanded, setExpanded] = useState<string | null>(null);
  const baselineMap = new Map(baseline.map((b) => [b.channel, b.median7d]));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">{t("title")}</h1>
        <p className="text-sm text-gray-500">{t("subtitle")}</p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-gray-800 mb-2">{t("baselineHeading")}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {baseline.map((b) => (
            <div key={b.channel} className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="text-xs text-gray-500">{b.channel}</div>
              <div className="text-xl font-bold text-gray-900">{b.median7d}</div>
              <div className="text-[10px] text-gray-400">{t("samples", { n: b.samples })}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-800 mb-2">{t("recentRuns")}</h2>
        <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-3 py-2">{t("col.runAt")}</th>
              <th className="text-left px-3 py-2">{t("col.status")}</th>
              <th className="text-right px-3 py-2">{t("col.totalRows")}</th>
              <th className="text-right px-3 py-2">{t("col.upserted")}</th>
              <th className="text-right px-3 py-2">{t("col.duration")}</th>
              <th className="text-left px-3 py-2">{t("col.channels")}</th>
            </tr>
          </thead>
          <tbody>
            {initialRuns.map((r) => (
              <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50/50">
                <td className="px-3 py-2 text-xs text-gray-700 font-mono">
                  {new Date(r.run_at).toISOString().slice(0, 16).replace("T", " ")}
                </td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                    r.status === "completed" ? "bg-green-100 text-green-700"
                    : r.status === "partial" ? "bg-amber-100 text-amber-700"
                    : r.status === "failed" ? "bg-red-100 text-red-700"
                    : "bg-gray-100 text-gray-700"
                  }`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">{r.total_rows}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{r.upserted}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : "-"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {r.channels.map((c) => {
                      const median = baselineMap.get(c.channel) ?? 0;
                      const ratioVal = ratio(c.rowCount, median);
                      return (
                        <span
                          key={c.channel}
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            !c.ok ? "bg-red-100 text-red-700" : anomalyClass(ratioVal)
                          }`}
                          title={c.error ?? `${c.rowCount} rows vs median ${median}`}
                        >
                          {c.channel}:{c.rowCount}
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/admin/HistoricalCrawlDashboard.tsx
git commit -m "feat(observability): admin dashboard component for crawl runs"
```

---

## Task 6: Admin page server wrapper

**Files:**
- Create: `app/[locale]/admin/historical-crawl/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import { loadBaseline } from "@/lib/historical-crawl/runs";
import HistoricalCrawlDashboard from "@/components/admin/HistoricalCrawlDashboard";

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function Page({ params }: PageProps) {
  const { locale } = await params;
  const auth = await requireUser(["admin"]);
  if ("error" in auth) {
    redirect(`/${locale}/login`);
  }

  const [{ data: runs }, baseline] = await Promise.all([
    auth.sb
      .from("historical_crawl_runs")
      .select(
        "id,run_at,completed_at,jst_date,status,total_rows,upserted,skipped_dup,channels,duration_ms,error",
      )
      .order("run_at", { ascending: false })
      .limit(30),
    loadBaseline(7),
  ]);

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <HistoricalCrawlDashboard
        initialRuns={(runs ?? []) as Parameters<typeof HistoricalCrawlDashboard>[0]["initialRuns"]}
        baseline={baseline}
      />
    </main>
  );
}
```

Note: the proxy already redirects non-admin users away from `/admin/*` (see `proxy.ts:38-40`), so the `requireUser` check here is defense-in-depth.

- [ ] **Step 2: Smoke test**

Visit `http://localhost:3000/ja/admin/historical-crawl` as admin. Expect: table rendering with the run row created in Task 3 and one baseline entry per channel that ran. Visit same URL as viewer/member — expect redirect.

- [ ] **Step 3: Commit**

```bash
git add app/[locale]/admin/historical-crawl/page.tsx
git commit -m "feat(observability): /admin/historical-crawl page"
```

---

## Task 7: i18n translations

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`

- [ ] **Step 1: Add Japanese keys to `messages/ja.json`**

Append under the top-level object, in the `admin` namespace (or create `admin` if missing):

```json
"admin": {
  "historicalCrawl": {
    "title": "他局OA収集モニター",
    "subtitle": "8チャネルの日次クロール状況と異常検知",
    "baselineHeading": "チャネル別ベースライン (直近7日中央値)",
    "samples": "{n}回のサンプル",
    "recentRuns": "直近の実行",
    "col": {
      "runAt": "実行時刻",
      "status": "状態",
      "totalRows": "総件数",
      "upserted": "新規",
      "duration": "所要",
      "channels": "チャネル別件数 (赤=失敗/-50%以下、橙=-80%以下)"
    }
  }
}
```

- [ ] **Step 2: Add Korean equivalent to `messages/ko.json`**

```json
"admin": {
  "historicalCrawl": {
    "title": "타사 방송 수집 모니터",
    "subtitle": "8개 채널 일일 크롤 상태 + 이상 감지",
    "baselineHeading": "채널별 기준 (최근 7일 중앙값)",
    "samples": "{n}회 샘플",
    "recentRuns": "최근 실행",
    "col": {
      "runAt": "실행시각",
      "status": "상태",
      "totalRows": "총 건수",
      "upserted": "신규",
      "duration": "소요",
      "channels": "채널별 건수 (적색=실패/-50% 이하, 황색=-80% 이하)"
    }
  }
}
```

- [ ] **Step 3: Verify the dashboard renders translations**

Re-visit `/ja/admin/historical-crawl` and `/ko/admin/historical-crawl`, confirm headings and column labels appear in the chosen language. No raw `admin.historicalCrawl.*` keys visible in DOM.

- [ ] **Step 4: Commit**

```bash
git add messages/ja.json messages/ko.json
git commit -m "i18n(admin): historical-crawl dashboard ja/ko keys"
```

---

## Task 8: Surface the dashboard in the navbar

**Files:**
- Modify: `components/Navbar.tsx`

- [ ] **Step 1: Add the admin link**

Locate the `{isAdmin && (` block in `components/Navbar.tsx` (currently wraps the `/admin/users` link). Inside that block, after the existing user-management link, add:

```tsx
<Link
  href={localePath(locale, `/admin/historical-crawl`)}
  className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
>
  <BarChart3 size={14} />
  {t('historicalCrawl')}
</Link>
```

Add the i18n key `nav.historicalCrawl` to both `ja.json` (`"他局OA収集"`) and `ko.json` (`"타사방송수집"`).

(The `BarChart3` icon is already imported in this file. If not, add to the lucide-react import.)

- [ ] **Step 2: Smoke test**

Reload the app as admin; verify the nav link appears and routes to the dashboard.

- [ ] **Step 3: Commit**

```bash
git add components/Navbar.tsx messages/ja.json messages/ko.json
git commit -m "nav: link to historical-crawl dashboard for admin role"
```

---

## Task 9: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append to the Broadcast Calendar section**

Locate the line "Discovery soft penalty (`lib/discovery/recent-broadcast-penalty.ts`)..." (added by PR #33) and add a new bullet after the "Phase B PoC" line and BEFORE the Phase C note:

```markdown
- Crawl observability (`lib/historical-crawl/runs.ts` + `/admin/historical-crawl` page): every `daily-historical-broadcasts` cron execution writes a row to `historical_crawl_runs` (admin-only RLS) with per-channel `rowCount` / `durationMs` / `error`. The admin dashboard surfaces the last 30 runs and a 7-day per-channel median; row counts dropping below 50% (red) or 80% (amber) of the median flag the channel for operator review. Treat this as the gate before adding category filtering or AI competitive analysis downstream.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): document historical-crawl observability"
```

---

## Task 10: Final PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/historical-crawl-quality-gate
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(observability): historical-crawl quality gate" --body "$(cat docs/superpowers/plans/2026-05-17-historical-crawl-quality-gate.md | head -30)"
```

- [ ] **Step 3: Verification plan in the PR body**

The PR description includes a checklist for the reviewer:

- [ ] Migration `2026-05-17_historical_crawl_runs.sql` applied to staging.
- [ ] Existing daily cron continues to succeed; new row appears in `historical_crawl_runs`.
- [ ] As admin, `/admin/historical-crawl` renders the table + baselines.
- [ ] As member/viewer, `/admin/historical-crawl` redirects.
- [ ] After 7+ daily runs, baselines populate and anomaly badges render correctly (manually force a low row count for one channel to verify red/amber states).

---

## Self-Review

- **Spec coverage**: Each goal in the problem statement maps to a task — observability table (T1), run helpers (T2), cron wiring (T3), admin API (T4), dashboard UI (T5+T6), i18n (T7), navbar entry (T8), docs (T9), shipping (T10).
- **Placeholder scan**: All code blocks contain runnable code. Verification steps include exact commands and expected output. No "TBD" or "similar to above" patterns.
- **Type consistency**: `PerChannelRunEntry` defined in Task 2 is imported by Task 3 (cron wiring) and Task 5 (dashboard). `ChannelBaseline` defined in Task 2 is consumed by Task 5. `RunStatus` flows from Task 2 → Task 3.
- **Conventions honored**: User-initiated API route uses `auth.sb` (not `getServiceClient`) and `private` cache header — matches the hardened conventions from PR #35. Cron continues to use `getServiceClient` (non-user path).
- **Constraints**: No new dependencies; no test framework needed (codebase has none — manual verification steps replace TDD checkpoints).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-historical-crawl-quality-gate.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, with review checkpoints between tasks.
2. **Inline Execution** — Execute tasks in this session with checkpoints for review.

Which approach?
