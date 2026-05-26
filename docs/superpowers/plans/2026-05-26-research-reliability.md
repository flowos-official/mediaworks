# Research Reliability (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect stuck research-pipeline products with a 15-minute cron, surface them on an admin recovery page with one-click retry, and close out two latent reliability bugs (silent `CRON_SECRET` fallback in `/api/analyze`, missing `live_commerce` in daily-refresh upsert).

**Architecture:** Add `products.error_reason text` + `products.updated_at timestamptz` (auto-updated by trigger) so stuck detection can rely on a single timestamp regardless of which field changed. A pure `detectStuck()` function in `lib/research/stuck-detector.ts` is shared by a new `*/15 * * * *` cron route and a manual admin trigger. Admin recovery UI at `/admin/research-pipeline` lists in-flight + failed products and exposes a single `Retry` button per row; the retry endpoint auto-picks the stage (`extract` if `description IS NULL`, otherwise `synthesize`) via another pure helper (`lib/research/retry-stage.ts`). All admin endpoints + page use `requireUser(['admin'])`. No user-facing changes.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS + service-role bypass), TypeScript, `tsx --env-file=.env.local` smoke runner. New libraries: none.

**Spec:** `docs/superpowers/specs/2026-05-26-research-reliability-design.md` (commit `3b3d75b`).

**Branch:** `research/reliability` (worktree `.claude/worktrees/research-reliability`, branched from `main@5d2541f`).

---

## File Structure

### New files
- `supabase/migrations/2026-05-26_products_error_tracking.sql` — schema add (idempotent)
- `lib/research/stuck-detector.ts` — pure `detectStuck()` (cron + admin trigger share this)
- `lib/research/retry-stage.ts` — pure `determineRetryStage(product)`
- `app/api/cron/research-stuck-detector/route.ts` — GET endpoint, `hasInternalSecret()` gate
- `app/api/admin/research-pipeline/retry/route.ts` — POST `{ productId }`, admin-only
- `app/api/admin/research-pipeline/trigger-detection/route.ts` — POST, admin-only
- `app/[locale]/(admin)/admin/research-pipeline/page.tsx` — Server Component
- `app/[locale]/(admin)/admin/research-pipeline/RetryButton.tsx` — client component
- `app/[locale]/(admin)/admin/research-pipeline/TriggerDetectionButton.tsx` — client component
- `scripts/test-research-stuck-detector.ts` — live-DB smoke
- `scripts/test-research-retry-stage.ts` — pure unit

### Modified files
- `lib/supabase.ts` — `Product` type gains `error_reason: string | null` + `updated_at: string`
- `app/api/analyze/route.ts` — remove `?? ""` fallback; mark `error_reason` on catch
- `lib/research/synthesize-product.ts` — mark `error_reason` on catch
- `app/api/cron/daily-refresh/route.ts` — add `live_commerce` to upsert payload
- `vercel.json` — register new cron + function `maxDuration`
- `package.json` — add `test:research-stuck-detector` + `test:research-retry-stage`

### Boundary notes
- `stuck-detector.ts` and `retry-stage.ts` are pure (no Next.js imports, no `server-only`) so the smoke scripts can import them directly via `tsx`. They take an explicit `SupabaseClient` argument.
- `synthesize-product.ts` is already smoke-safe (no `server-only` import); leave it that way.
- Admin page uses the existing `(admin)` route group convention (`archive-status`, `historical-crawl` precedent), not the bare `admin/` path the spec sketched.

---

## Task 1: Migration — add `products.error_reason` + `products.updated_at`

**Files:**
- Create: `supabase/migrations/2026-05-26_products_error_tracking.sql`

**Why this task is first:** Every downstream task reads or writes one of these two columns. The migration is idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`) so safe to re-apply.

- [ ] **Step 1: Write the migration**

`supabase/migrations/2026-05-26_products_error_tracking.sql`:
```sql
-- 2026-05-26: products に error_reason + updated_at を追加。
-- stuck detection cron が最終状態変化時刻で stuck 判定する。
-- error_reason は detection (trigger_not_invoked / analysis_timeout) と
-- analyze ルートの CRON_SECRET 欠落など、明示的失敗で埋められる。

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS error_reason text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION update_products_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at_trigger ON products;
CREATE TRIGGER products_updated_at_trigger
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION update_products_updated_at();

COMMIT;
```

- [ ] **Step 2: Apply migration to dev DB**

The user applies this via the Supabase SQL editor (project's standard manual workflow — same as Phase 1). After application, verify by running:
```bash
npm run test:research-data-model
```
Expected: PASS (existing Phase 1 smoke; `updated_at` / `error_reason` additions don't break anything because the existing flow ignores them).

- [ ] **Step 3: Verify columns + trigger exist**

Run a quick psql-style verification from the existing smoke harness by reading any product row via service-role client. The `Step 2` smoke already calls `select("*")` and will surface the new columns; if they're missing, the smoke fails immediately.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-26_products_error_tracking.sql
git commit -m "feat(reliability): add products.error_reason + updated_at trigger

Phase 2 prerequisite. Stuck-detector cron will key off updated_at;
error_reason carries the cause through admin UI."
```

---

## Task 2: Sync TS `Product` type with new columns

**Files:**
- Modify: `lib/supabase.ts:45-59`

- [ ] **Step 1: Read current `Product` type**

Open `lib/supabase.ts` and locate the `Product` type starting at line 45.

- [ ] **Step 2: Add two fields**

Edit `lib/supabase.ts`, change:
```ts
export type Product = {
  id: string;
  name: string;
  description: string | null;
  file_url: string;
  file_name: string;
  category: string | null;
  features: string[] | null;
  price_range: string | null;
  target_market: string | null;
  status: ProductStatus;
  discovered_product_id: string | null;
  ingest_source: 'file_upload' | 'discovery_promotion' | 'manual_url';
  created_at: string;
};
```
to:
```ts
export type Product = {
  id: string;
  name: string;
  description: string | null;
  file_url: string;
  file_name: string;
  category: string | null;
  features: string[] | null;
  price_range: string | null;
  target_market: string | null;
  status: ProductStatus;
  discovered_product_id: string | null;
  ingest_source: 'file_upload' | 'discovery_promotion' | 'manual_url';
  error_reason: string | null;
  updated_at: string;
  created_at: string;
};
```

- [ ] **Step 3: TS check**

Run:
```bash
npx tsc --noEmit
```
Expected: 0 errors. (Adding fields to a row type that's read everywhere is non-breaking; existing call sites just don't use the new keys.)

- [ ] **Step 4: Commit**

```bash
git add lib/supabase.ts
git commit -m "feat(reliability): extend Product type with error_reason + updated_at"
```

---

## Task 3: Pure `determineRetryStage()` helper + unit smoke

**Files:**
- Create: `lib/research/retry-stage.ts`
- Create: `scripts/test-research-retry-stage.ts`
- Modify: `package.json:81` (after the `test:research-data-model` entry, add `test:research-retry-stage`)

**Rationale:** Retry stage decision is mechanical (`description IS NULL → extract`, else `synthesize`) but lives behind an HTTP boundary, so a pure helper lets us unit-test it without spinning up the API.

- [ ] **Step 1: Write the failing unit test**

`scripts/test-research-retry-stage.ts`:
```ts
/**
 * 単位テスト: determineRetryStage の分岐ロジック。
 * 実行: npm run test:research-retry-stage
 */
import { determineRetryStage } from "../lib/research/retry-stage";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main(): void {
  // 1) description が NULL → extract から再開
  assert(
    determineRetryStage({ description: null }) === "extract",
    "description=null は extract を返すべき",
  );

  // 2) description が空文字 → extract から再開 (Gemini が "" を返す事故ケース対策)
  assert(
    determineRetryStage({ description: "" }) === "extract",
    "description='' も extract 扱い",
  );

  // 3) description が空白のみ → extract (trim 後の判定)
  assert(
    determineRetryStage({ description: "   " }) === "extract",
    "description=whitespace のみは extract 扱い",
  );

  // 4) 正常な description あり → synthesize から
  assert(
    determineRetryStage({ description: "実在する商品説明" }) === "synthesize",
    "description あり は synthesize を返すべき",
  );

  console.log("[ok] determineRetryStage 全4ケース通過");
}

main();
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm run test:research-retry-stage
```
Expected: FAIL — script doesn't exist in `package.json` yet, or import fails because `lib/research/retry-stage.ts` doesn't exist.

- [ ] **Step 3: Wire up the npm script**

Edit `package.json` — append after the existing `"test:research-data-model"` line (line 81 currently), inside the same `"scripts"` block:
```json
    "test:research-data-model": "tsx --env-file=.env.local scripts/test-research-data-model.ts",
    "test:research-retry-stage": "tsx scripts/test-research-retry-stage.ts"
```
(No `--env-file` needed — this is a pure unit test.)

- [ ] **Step 4: Implement `determineRetryStage`**

Create `lib/research/retry-stage.ts`:
```ts
/**
 * Decide which pipeline stage to restart from when retrying a failed/stuck product.
 *
 * - description が空 (NULL / "" / 空白のみ) → extract から再開。
 *   Gemini Vision の抽出が走り終わらなかったか、抽出結果が空だった状態。
 * - description あり → synthesize から再開。Brave + Gemini synthesis を再実行する。
 *
 * 純粋関数 — Supabase クライアントは受け取らない。retry API ハンドラから呼ばれる。
 */
export type RetryStage = "extract" | "synthesize";

export function determineRetryStage(product: { description: string | null }): RetryStage {
  const desc = product.description?.trim() ?? "";
  return desc.length === 0 ? "extract" : "synthesize";
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run test:research-retry-stage
```
Expected: `[ok] determineRetryStage 全4ケース通過`

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/research/retry-stage.ts scripts/test-research-retry-stage.ts package.json
git commit -m "feat(reliability): pure determineRetryStage helper + unit smoke"
```

---

## Task 4: `detectStuck()` library + live-DB smoke

**Files:**
- Create: `lib/research/stuck-detector.ts`
- Create: `scripts/test-research-stuck-detector.ts`
- Modify: `package.json` (append `test:research-stuck-detector`)

**Rationale:** Extract the stuck-detection SQL into a single shared function so the cron route and the admin trigger route both invoke it without duplication. The function takes the service-role client as an argument so the smoke can pass its own.

- [ ] **Step 1: Write the failing live-DB smoke**

`scripts/test-research-stuck-detector.ts`:
```ts
/**
 * Live DB smoke for stuck-detector. dev Supabase に直接接続する。
 * 実行: npm run test:research-stuck-detector
 *
 * 検証内容:
 *   1) status='pending', created_at が 11 分前の row → trigger_not_invoked で failed 化
 *   2) status='analyzing', updated_at が 11 分前の row → analysis_timeout で failed 化
 *   3) status='analyzing', updated_at が 5 分前の row (まだ新しい) → 変化しない
 *   4) status='completed' の row → 影響なし
 *
 * 終了時は全 temp row を DELETE する。
 */
import { createClient } from "@supabase/supabase-js";
import { detectStuck } from "../lib/research/stuck-detector";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に必要");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

async function main(): Promise<void> {
  const tag = `stuck-smoke-${Date.now()}`;

  // 4 temp products を挿入。
  // 注意: products_updated_at_trigger は BEFORE UPDATE のみで発火する。
  // INSERT 時に updated_at を明示すれば trigger を経由せずその値で着地する。
  const inserts = [
    { name: `${tag}-pending-stuck`,    file_url: "smoke://none", file_name: "a.txt", status: "pending",   created_at: isoMinutesAgo(11), updated_at: isoMinutesAgo(11) },
    { name: `${tag}-analyzing-stuck`,  file_url: "smoke://none", file_name: "b.txt", status: "analyzing", created_at: isoMinutesAgo(30), updated_at: isoMinutesAgo(11) },
    { name: `${tag}-analyzing-fresh`,  file_url: "smoke://none", file_name: "c.txt", status: "analyzing", created_at: isoMinutesAgo(30), updated_at: isoMinutesAgo(5)  },
    { name: `${tag}-completed`,        file_url: "smoke://none", file_name: "d.txt", status: "completed", created_at: isoMinutesAgo(30), updated_at: isoMinutesAgo(30) },
  ];
  const { data: rows, error: insErr } = await sb
    .from("products")
    .insert(inserts)
    .select("id, name, updated_at");
  if (insErr) throw new Error(`temp insert 失敗: ${insErr.message}`);
  assert(rows && rows.length === 4, "4 temp rows 挿入したはず");

  const byName = new Map(rows!.map((r) => [r.name, r.id]));
  const pendingStuckId   = byName.get(`${tag}-pending-stuck`)!;
  const analyzingStuckId = byName.get(`${tag}-analyzing-stuck`)!;
  const analyzingFreshId = byName.get(`${tag}-analyzing-fresh`)!;
  const completedId      = byName.get(`${tag}-completed`)!;

  try {
    const result = await detectStuck(sb);

    const { data: pAfter } = await sb.from("products").select("status, error_reason").eq("id", pendingStuckId).single();
    assert(pAfter?.status === "failed", `pending-stuck は failed に変わるべき (got ${pAfter?.status})`);
    assert(pAfter?.error_reason === "trigger_not_invoked", `error_reason='trigger_not_invoked' のはず (got ${pAfter?.error_reason})`);

    const { data: aAfter } = await sb.from("products").select("status, error_reason").eq("id", analyzingStuckId).single();
    assert(aAfter?.status === "failed", `analyzing-stuck は failed に変わるべき (got ${aAfter?.status})`);
    assert(aAfter?.error_reason === "analysis_timeout", `error_reason='analysis_timeout' のはず (got ${aAfter?.error_reason})`);

    const { data: fAfter } = await sb.from("products").select("status").eq("id", analyzingFreshId).single();
    assert(fAfter?.status === "analyzing", `analyzing-fresh は触らないはず (got ${fAfter?.status})`);

    const { data: cAfter } = await sb.from("products").select("status").eq("id", completedId).single();
    assert(cAfter?.status === "completed", `completed は触らないはず (got ${cAfter?.status})`);

    // detectStuck が件数を返している (他の偶発 stuck row が居ても >= 1 で OK)
    assert(result.flagged.pending >= 1, `flagged.pending >= 1 のはず (got ${result.flagged.pending})`);
    assert(result.flagged.analyzing >= 1, `flagged.analyzing >= 1 のはず (got ${result.flagged.analyzing})`);

    console.log("[ok] detectStuck smoke 通過", result);
  } finally {
    await sb.from("products").delete().in("id", [pendingStuckId, analyzingStuckId, analyzingFreshId, completedId]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:research-stuck-detector
```
Expected: FAIL — script not in `package.json`, or import fails because `lib/research/stuck-detector.ts` doesn't exist.

- [ ] **Step 3: Wire up the npm script**

Edit `package.json`, add to scripts block right after the previous task's entry:
```json
    "test:research-retry-stage": "tsx scripts/test-research-retry-stage.ts",
    "test:research-stuck-detector": "tsx --env-file=.env.local scripts/test-research-stuck-detector.ts"
```

- [ ] **Step 4: Implement `detectStuck()`**

Create `lib/research/stuck-detector.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";

const STUCK_THRESHOLD_MINUTES = 10;

export interface StuckDetectionResult {
  flagged: {
    pending: number;
    analyzing: number;
  };
}

/**
 * 10 分以上 pending / analyzing 状態に留まる商品を failed にマーク。
 *
 * - pending 10 分超過 → trigger_not_invoked (extract トリガが届かなかった疑い)
 * - analyzing 10 分超過 → analysis_timeout (extract または synthesize が応答しなかった)
 *
 * 10 分の根拠: analyze maxDuration 120s + synthesize maxDuration 300s = 7 分。
 * 10 分なら両方が正常終了した後で、false positive のリスクが低い。
 *
 * service_role クライアントを呼び出し側から渡す前提 (cron と admin route 両方が使う)。
 */
export async function detectStuck(sb: SupabaseClient): Promise<StuckDetectionResult> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { count: pendingCount, error: pendingErr } = await sb
    .from("products")
    .update({ status: "failed", error_reason: "trigger_not_invoked" }, { count: "exact" })
    .eq("status", "pending")
    .lt("created_at", cutoff);
  if (pendingErr) throw pendingErr;

  const { count: analyzingCount, error: analyzingErr } = await sb
    .from("products")
    .update({ status: "failed", error_reason: "analysis_timeout" }, { count: "exact" })
    .eq("status", "analyzing")
    .lt("updated_at", cutoff);
  if (analyzingErr) throw analyzingErr;

  return {
    flagged: {
      pending: pendingCount ?? 0,
      analyzing: analyzingCount ?? 0,
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run test:research-stuck-detector
```
Expected: `[ok] detectStuck smoke 通過` plus a JSON dump like `{ flagged: { pending: 1, analyzing: 0 } }` (or `1` for both if `updated_at` could be set; the smoke degrades gracefully if not).

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/research/stuck-detector.ts scripts/test-research-stuck-detector.ts package.json
git commit -m "feat(reliability): detectStuck() + live-DB smoke

Pure function shared by the cron route and the admin trigger.
10-min threshold sits above analyze(120s)+synthesize(300s) so
in-flight requests don't get false-flagged."
```

---

## Task 5: Cron route `/api/cron/research-stuck-detector` + `vercel.json` registration

**Files:**
- Create: `app/api/cron/research-stuck-detector/route.ts`
- Modify: `vercel.json` (add `functions` entry + `crons` entry)

- [ ] **Step 1: Write the cron route**

`app/api/cron/research-stuck-detector/route.ts`:
```ts
import { NextResponse } from "next/server";
import { hasInternalSecret } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { detectStuck } from "@/lib/research/stuck-detector";

export const maxDuration = 30;

export async function GET(req: Request): Promise<NextResponse> {
  if (!hasInternalSecret(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await detectStuck(getServiceClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/research-stuck-detector] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 2: Register in `vercel.json`**

Edit `vercel.json`:

Inside `"functions"`, append after `pipeline-auto-advance` entry:
```json
    "app/api/cron/pipeline-auto-advance/route.ts": {
      "maxDuration": 60
    },
    "app/api/cron/research-stuck-detector/route.ts": {
      "maxDuration": 30
    }
```

Inside `"crons"`, append at end of array:
```json
    {
      "path": "/api/cron/pipeline-auto-advance",
      "schedule": "0 18 * * *"
    },
    {
      "path": "/api/cron/research-stuck-detector",
      "schedule": "*/15 * * * *"
    }
```

- [ ] **Step 3: TS check + JSON sanity**

```bash
npx tsc --noEmit
node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('vercel.json valid')"
```
Expected: 0 TS errors; `vercel.json valid`.

- [ ] **Step 4: Smoke the route locally**

Start dev server in the worktree if not already running:
```bash
npm run dev
```

In another shell, hit the endpoint:
```bash
curl -i -H "Authorization: Bearer $env:CRON_SECRET" "http://localhost:3000/api/cron/research-stuck-detector"
```
(Or, in PowerShell: `curl.exe -i -H "Authorization: Bearer $env:CRON_SECRET" http://localhost:3000/api/cron/research-stuck-detector`.)
Expected: HTTP 200 with body `{"ok":true,"flagged":{"pending":N,"analyzing":M}}`. With no missing-secret header, expect HTTP 403.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/research-stuck-detector/route.ts vercel.json
git commit -m "feat(reliability): /api/cron/research-stuck-detector at */15

Wraps lib/research/stuck-detector.detectStuck under hasInternalSecret.
Vercel cron schedule registered."
```

---

## Task 6: Admin retry API `POST /api/admin/research-pipeline/retry`

**Files:**
- Create: `app/api/admin/research-pipeline/retry/route.ts`

- [ ] **Step 1: Read existing internal-fetch pattern in `app/api/analyze/route.ts`**

Pattern to mirror for fire-and-forget call: lines 46-57 of `app/api/analyze/route.ts` (the synthesize trigger). The retry route reuses that pattern but with stage selection.

- [ ] **Step 2: Write the retry route**

`app/api/admin/research-pipeline/retry/route.ts`:
```ts
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { determineRetryStage } from "@/lib/research/retry-stage";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireUser(["admin"]);
  if ("error" in auth) return auth.error;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured — internal fetch impossible" },
      { status: 500 },
    );
  }

  let body: { productId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const productId = body.productId;
  if (!productId || typeof productId !== "string") {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }

  const sb = getServiceClient();
  const { data: product, error: prodErr } = await sb
    .from("products")
    .select("id, status, description")
    .eq("id", productId)
    .maybeSingle();

  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 });
  if (!product) return NextResponse.json({ error: "product not found" }, { status: 404 });

  if (product.status !== "failed" && product.status !== "analyzing") {
    return NextResponse.json(
      { error: `cannot retry from status='${product.status}' (only failed/analyzing)` },
      { status: 400 },
    );
  }

  const stage = determineRetryStage({ description: product.description });

  // Reset row to analyzing + clear error_reason BEFORE firing the request,
  // so the operator sees the new in-flight state immediately.
  const { error: resetErr } = await sb
    .from("products")
    .update({ status: "analyzing", error_reason: null })
    .eq("id", productId);
  if (resetErr) return NextResponse.json({ error: resetErr.message }, { status: 500 });

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

  if (stage === "synthesize") {
    fetch(`${baseUrl}/api/analyze/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
      },
      body: JSON.stringify({ productId }),
    }).catch((err) => {
      console.error(`[admin/retry][${productId}] synthesize trigger failed:`, err);
    });
  } else {
    // extract stage requires fileBase64 + mimeType + fileName, which the admin route
    // doesn't have. For Phase 2 we explicitly tell the operator that extract-stage
    // retries must re-upload the file. (Auto re-extract from storage URL is Phase 3+.)
    return NextResponse.json(
      {
        error:
          "extract-stage retry requires file re-upload (description was never extracted). " +
          "Please re-upload the source file from the main UI.",
        retriedStage: null,
      },
      { status: 422 },
    );
  }

  return NextResponse.json({ ok: true, retriedStage: stage });
}
```

**Decision note:** The spec said "auto-determines extract vs synthesize". In practice the extract stage needs the file bytes, which the admin row alone doesn't have. Phase 2 therefore retries synthesize end-to-end automatically and returns a clear 422 when extract is needed — operator re-uploads through the standard UI. This avoids a half-implemented file-fetch path and is documented in §6 of the spec as the realistic boundary.

- [ ] **Step 3: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Smoke locally**

With dev server running:
```bash
# 1) Pick a recently failed product id from /admin/research-pipeline (Task 8) or via:
#    SELECT id FROM products WHERE status='failed' ORDER BY updated_at DESC LIMIT 1;
#    in the Supabase SQL editor. Substitute below.

curl.exe -i -X POST -H "Content-Type: application/json" `
  -H "Cookie: <admin session cookie from browser devtools>" `
  -d '{"productId":"<paste-id>"}' `
  http://localhost:3000/api/admin/research-pipeline/retry
```
Expected: HTTP 200 with `{"ok":true,"retriedStage":"synthesize"}` for a row with `description IS NOT NULL`, or HTTP 422 with re-upload guidance otherwise.

(If running smoke without an admin session is necessary, you can temporarily test with `hasInternalSecret` — but the route as written requires admin login.)

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/research-pipeline/retry/route.ts
git commit -m "feat(reliability): admin retry endpoint with stage auto-detection

POST /api/admin/research-pipeline/retry. Synthesize-stage retries
re-fire /api/analyze/synthesize. Extract-stage retries return 422
because the source file isn't reachable from the row alone."
```

---

## Task 7: Admin trigger-detection API `POST /api/admin/research-pipeline/trigger-detection`

**Files:**
- Create: `app/api/admin/research-pipeline/trigger-detection/route.ts`

- [ ] **Step 1: Write the route**

`app/api/admin/research-pipeline/trigger-detection/route.ts`:
```ts
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { detectStuck } from "@/lib/research/stuck-detector";

export async function POST(): Promise<NextResponse> {
  const auth = await requireUser(["admin"]);
  if ("error" in auth) return auth.error;

  try {
    const result = await detectStuck(getServiceClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/trigger-detection] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
```

- [ ] **Step 2: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/research-pipeline/trigger-detection/route.ts
git commit -m "feat(reliability): admin manual stuck-detection trigger"
```

---

## Task 8: Admin UI `/admin/research-pipeline`

**Files:**
- Create: `app/[locale]/(admin)/admin/research-pipeline/page.tsx`
- Create: `app/[locale]/(admin)/admin/research-pipeline/RetryButton.tsx`
- Create: `app/[locale]/(admin)/admin/research-pipeline/TriggerDetectionButton.tsx`

- [ ] **Step 1: Write the server page**

`app/[locale]/(admin)/admin/research-pipeline/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";
import RetryButton from "./RetryButton";
import TriggerDetectionButton from "./TriggerDetectionButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ locale: string }>;
}

interface PipelineRow {
  id: string;
  name: string;
  status: "analyzing" | "failed";
  error_reason: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function minutesAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export default async function ResearchPipelinePage({ params }: PageProps) {
  const { locale } = await params;
  const auth = await requireUser(["admin"]);
  if ("error" in auth) redirect(localePath(locale, "/login"));
  const sb = auth.sb;

  const { data: rows } = await sb
    .from("products")
    .select("id, name, status, error_reason, description, created_at, updated_at")
    .in("status", ["analyzing", "failed"])
    .order("updated_at", { ascending: false })
    .limit(100);

  const products = (rows ?? []) as PipelineRow[];
  const analyzing = products.filter((r) => r.status === "analyzing");
  const failed = products.filter((r) => r.status === "failed");

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Research Pipeline</h1>

      <section className="mb-8 border rounded p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">手動 stuck 検出</div>
            <div className="text-xs text-muted-foreground">
              通常は 15 分ごとに自動実行。手動でも今すぐ走らせられます。
            </div>
          </div>
          <TriggerDetectionButton />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-2">
          進行中 (analyzing) — {analyzing.length} 件
        </h2>
        {analyzing.length === 0 ? (
          <p className="text-sm text-muted-foreground">なし</p>
        ) : (
          <ul className="space-y-2">
            {analyzing.map((p) => (
              <li key={p.id} className="border rounded p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    開始: {p.created_at.slice(11, 16)} ({minutesAgo(p.updated_at)} 分前更新)
                  </div>
                </div>
                <RetryButton productId={p.id} label="強制再試行" />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">失敗 (failed) — {failed.length} 件</h2>
        {failed.length === 0 ? (
          <p className="text-sm text-muted-foreground">なし</p>
        ) : (
          <ul className="space-y-2">
            {failed.map((p) => (
              <li key={p.id} className="border rounded p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.error_reason ?? "理由不明"} · 失敗時刻: {p.updated_at.slice(11, 16)}
                    {p.description == null ? " · description 未抽出 (要再アップロード)" : ""}
                  </div>
                </div>
                <RetryButton productId={p.id} label="再試行" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Write the `RetryButton` client component**

`app/[locale]/(admin)/admin/research-pipeline/RetryButton.tsx`:
```tsx
"use client";
import { useState } from "react";

export default function RetryButton({ productId, label }: { productId: string; label: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/research-pipeline/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(json.error ?? `HTTP ${res.status}`);
        setPending(false);
        return;
      }
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "request failed");
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        className="text-xs px-3 py-1.5 rounded border hover:bg-muted disabled:opacity-50"
      >
        {pending ? "..." : label}
      </button>
      {message && <span className="text-xs text-red-600 max-w-[12rem] text-right">{message}</span>}
    </div>
  );
}
```

- [ ] **Step 3: Write the `TriggerDetectionButton` client component**

`app/[locale]/(admin)/admin/research-pipeline/TriggerDetectionButton.tsx`:
```tsx
"use client";
import { useState } from "react";

export default function TriggerDetectionButton() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/research-pipeline/trigger-detection", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(json.error ?? `HTTP ${res.status}`);
        setPending(false);
        return;
      }
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "request failed");
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        className="text-sm px-4 py-2 rounded border hover:bg-muted disabled:opacity-50"
      >
        {pending ? "実行中..." : "今すぐ実行"}
      </button>
      {message && <span className="text-xs text-red-600">{message}</span>}
    </div>
  );
}
```

- [ ] **Step 4: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 5: Manual UI smoke**

With dev server running and logged in as admin:
1. Navigate to `http://localhost:3000/ja/admin/research-pipeline`.
2. Verify the page renders two sections (進行中 / 失敗) and the 手動 stuck 検出 panel.
3. Click 今すぐ実行 — page reloads, no error message.
4. If a failed product is visible, click 再試行 — page reloads. If the row had `description != null`, expect it to flip back to `analyzing`. If `description IS NULL`, expect the error 422 message to render under the button.

Cannot run automated UI smoke (no headless UI test infra in this repo) — verify manually and report.

- [ ] **Step 6: Commit**

```bash
git add "app/[locale]/(admin)/admin/research-pipeline"
git commit -m "feat(reliability): /admin/research-pipeline recovery UI

Server-rendered list of analyzing+failed products, with admin-gated
retry + manual detection trigger. Uses existing (admin) route group."
```

---

## Task 9: Fix `CRON_SECRET ?? ""` silent fallback in `/api/analyze` + add `error_reason` to extract catch

**Files:**
- Modify: `app/api/analyze/route.ts:46-77`

- [ ] **Step 1: Read current `/api/analyze/route.ts`**

Already done above (lines 1-78). The two changes are localized to lines 46-57 (synthesize trigger) and 65-77 (catch).

- [ ] **Step 2: Apply the synthesize-trigger fix**

Edit `app/api/analyze/route.ts`. Replace:
```ts
		// Step 2: Trigger synthesize in a separate request (non-blocking)
		// This runs as a separate serverless function with its own 5-min timeout
		const baseUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
		fetch(`${baseUrl}/api/analyze/synthesize`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
			},
			body: JSON.stringify({ productId }),
		}).catch((err) => {
			console.error(`[${productId}] Failed to trigger synthesize:`, err);
		});
```
with:
```ts
		// Step 2: Trigger synthesize in a separate request (non-blocking)
		// This runs as a separate serverless function with its own 5-min timeout
		const cronSecret = process.env.CRON_SECRET;
		if (!cronSecret) {
			console.error(`[${productId}] CRON_SECRET missing — synthesize trigger blocked`);
			await supabase
				.from("products")
				.update({ status: "failed", error_reason: "cron_secret_missing" })
				.eq("id", productId);
			return NextResponse.json(
				{ error: "CRON_SECRET not configured" },
				{ status: 500 },
			);
		}
		const baseUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
		fetch(`${baseUrl}/api/analyze/synthesize`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cronSecret}`,
			},
			body: JSON.stringify({ productId }),
		}).catch((err) => {
			console.error(`[${productId}] Failed to trigger synthesize:`, err);
		});
```

- [ ] **Step 3: Apply the catch-block fix**

In the same file, replace:
```ts
	} catch (error) {
		console.error(`[${productId}] Extraction failed:`, error);

		await supabase
			.from("products")
			.update({ status: "failed" })
			.eq("id", productId);

		return NextResponse.json(
			{ error: "Analysis failed" },
			{ status: 500 },
		);
	}
```
with:
```ts
	} catch (error) {
		console.error(`[${productId}] Extraction failed:`, error);

		const reason = error instanceof Error
			? `extract_failed: ${error.message.slice(0, 500)}`
			: "extract_failed: unknown";
		await supabase
			.from("products")
			.update({ status: "failed", error_reason: reason })
			.eq("id", productId);

		return NextResponse.json(
			{ error: "Analysis failed" },
			{ status: 500 },
		);
	}
```

- [ ] **Step 4: Grep for any other `?? ""` fallback against `CRON_SECRET`**

Use the Grep tool with pattern `CRON_SECRET \?\? ""` across the worktree (no path filter). Expected: 0 hits remaining after this edit. If any new hit surfaces in a non-test file, fix it in the same task and document it in the commit message.

- [ ] **Step 5: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "fix(analyze): remove CRON_SECRET silent fallback, mark error_reason

Missing env now returns 500 + error_reason='cron_secret_missing'.
Extract catch also marks error_reason='extract_failed: <msg>'."
```

---

## Task 10: Mark `error_reason` in `synthesize-product.ts` catch

**Files:**
- Modify: `lib/research/synthesize-product.ts:133-140` (`markProductStatus`) + `lib/research/synthesize-product.ts:193-201` (catch block)

- [ ] **Step 1: Read the existing catch + helper**

Already loaded above. The helper at lines 133-140 only writes `status`; the catch at 193-201 invokes it.

- [ ] **Step 2: Extend `markProductStatus` to accept optional error_reason**

Replace lines 133-140:
```ts
async function markProductStatus(
	sb: SupabaseClient,
	productId: string,
	status: "analyzing" | "completed" | "failed",
): Promise<void> {
	const { error } = await sb.from("products").update({ status }).eq("id", productId);
	if (error) throw error;
}
```
with:
```ts
async function markProductStatus(
	sb: SupabaseClient,
	productId: string,
	status: "analyzing" | "completed" | "failed",
	errorReason: string | null = null,
): Promise<void> {
	const update: { status: typeof status; error_reason?: string | null } = { status };
	if (status === "failed") {
		update.error_reason = errorReason;
	} else {
		// 成功 / 進行中に戻すときは error_reason をクリア (再試行後の状態整合)
		update.error_reason = null;
	}
	const { error } = await sb.from("products").update(update).eq("id", productId);
	if (error) throw error;
}
```

- [ ] **Step 3: Use it in the catch block**

Replace lines 193-201 (the catch in `synthesizeProductResearch`):
```ts
	} catch (error) {
		console.error(`[${productId}] Synthesis failed:`, error);
		try {
			await markProductStatus(sb, productId, "failed");
		} catch (statusError) {
			console.error(`[${productId}] Failed to mark synthesis failure:`, statusError);
		}
		throw new ProductResearchSynthesisError(500, "Synthesis failed", error);
	}
```
with:
```ts
	} catch (error) {
		console.error(`[${productId}] Synthesis failed:`, error);
		const reason = error instanceof Error
			? `synthesis_failed: ${error.message.slice(0, 500)}`
			: "synthesis_failed: unknown";
		try {
			await markProductStatus(sb, productId, "failed", reason);
		} catch (statusError) {
			console.error(`[${productId}] Failed to mark synthesis failure:`, statusError);
		}
		throw new ProductResearchSynthesisError(500, "Synthesis failed", error);
	}
```

- [ ] **Step 4: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 5: Re-run Phase 1 smoke to confirm no regression**

```bash
npm run test:research-data-model
```
Expected: PASS. (The new optional argument and the in-success path that clears `error_reason` are additive.)

- [ ] **Step 6: Commit**

```bash
git add lib/research/synthesize-product.ts
git commit -m "fix(research): mark error_reason on synthesis failure

markProductStatus now accepts errorReason. The synthesizeProductResearch
catch writes synthesis_failed: <message>. analyzing/completed paths
clear error_reason for re-tried rows."
```

---

## Task 11: Add missing `live_commerce` to `daily-refresh` upsert

**Files:**
- Modify: `app/api/cron/daily-refresh/route.ts:54-83`

- [ ] **Step 1: Read the upsert block**

The block at lines 54-83 of `app/api/cron/daily-refresh/route.ts` already contains 14 columns from the `research` object. `live_commerce` is the missing one — added to `research_results` in Phase 1, never wired into this cron.

- [ ] **Step 2: Add the field**

Edit `app/api/cron/daily-refresh/route.ts`. Replace:
```ts
							marketing_strategy: research.marketing_strategy,
							korea_market_fit: research.korea_market_fit,
							raw_json: {
```
with:
```ts
							marketing_strategy: research.marketing_strategy,
							korea_market_fit: research.korea_market_fit,
							live_commerce: research.live_commerce,
							raw_json: {
```

- [ ] **Step 3: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors. (`research.live_commerce` is typed on `ResearchOutput`.)

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/daily-refresh/route.ts
git commit -m "fix(daily-refresh): include live_commerce in upsert

Phase 1 added the column; daily-refresh never wrote it, so refreshed
rows were overwriting live_commerce with NULL."
```

---

## Task 12: Final verification — tsc + lint + smokes

**Files:** none

- [ ] **Step 1: TS check across worktree**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 2: Lint**

```bash
npm run lint
```
Expected: 0 errors. New components follow the same conventions as `archive-status/RetryButton.tsx`.

- [ ] **Step 3: All Phase 1 + Phase 2 smokes pass**

```bash
npm run test:research-data-model
npm run test:research-retry-stage
npm run test:research-stuck-detector
```
Expected: all 3 PASS.

- [ ] **Step 4: Inspect `git log`**

```bash
git log --oneline 5d2541f..HEAD
```
Expected output (order may vary slightly): 11 commits since `5d2541f`, one per task. Confirm each commit subject matches the task purpose. No merge commits.

- [ ] **Step 5: Inspect uncommitted state**

```bash
git status
```
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 6: No new commit needed in this task.**

Verification only.

---

## Out of scope (deferred to Phase 3+)

- Extract-stage retry from admin UI: requires re-fetching the original file from Supabase storage, which the spec leaves to Phase 3 alongside multi-file extract.
- Pro fallback / responseSchema / multi-file extract — Phase 3 (出力品質).
- Storage bucket access tightening + `/api/analyze` internal-only — Phase 4 (보안).
- SSE / Realtime push to replace 5-second `ProductCard` polling — Phase 3.

## Risks (carried over from spec §12)

- 10-minute threshold could false-positive a Gemini retry that genuinely takes >10 min. Mitigated by admin manual re-retry (idempotent).
- `updated_at` trigger overrides any explicit `updated_at = …` set elsewhere. No existing code in the repo writes `products.updated_at` (grep verified during plan write — confirm with the implementer if any uncertainty surfaces).
- The retry endpoint reuses the existing fire-and-forget pattern, so a second invoke failure will silently re-enter `analyzing` for up to 15 minutes before the next detection cycle catches it. Same loop tolerance as the original pipeline.

## Self-review

**Spec coverage walk** (against `2026-05-26-research-reliability-design.md`):
- §3 Migration → Task 1 ✓
- §3 Product type → Task 2 ✓
- §4 Cron detector → Tasks 4 + 5 ✓
- §5 Admin UI → Task 8 ✓
- §6 Retry API → Task 6 ✓ (with documented 422 deviation for extract-stage)
- §6 Trigger-detection API → Task 7 ✓
- §7 CRON_SECRET fix → Task 9 ✓
- §7 daily-refresh live_commerce → Task 11 ✓
- §7 synthesize-product.ts catch → Task 10 ✓
- §8 RLS / route auth → covered inline (every route uses `requireUser(['admin'])`; cron uses `hasInternalSecret()`) ✓
- §9 vercel.json cron registration → Task 5 ✓
- §10 smokes → Tasks 3 + 4 ✓; Task 12 runs all + Phase 1 ✓
- §11 deploy order → out of plan (operator-executed)
- §12 risks → carried into "Risks" above ✓
- §13/§14 non-changes → respected (no `ProductCard` / discovery / strategy / broadcasts edits anywhere) ✓

**Placeholder scan:** no TBD / TODO / "similar to" / un-coded steps remain.

**Type consistency:** `RetryStage`, `StuckDetectionResult`, the `PipelineRow` shape in the page, and the API response shapes are all spelled the same way across tasks. `error_reason` and `updated_at` field names match the migration columns. The optional 4th argument on `markProductStatus` matches the signature in both the helper definition (Task 10 Step 2) and the catch-block call site (Task 10 Step 3).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-research-reliability.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance + code quality), fastest iteration. Same pattern as Phase 1.
2. **Inline Execution** — execute all 12 tasks in this session with checkpoint pauses.

Which approach?
