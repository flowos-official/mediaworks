# Product Selection Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4-stage selection pipeline (selected → sourcing → scheduled → closed) on top of `discovered_products.user_action='sourced'`, surfaced as a kanban board at `/analytics/pipeline`. Unify the feedback affordance on `/strategy/expansion` (Phase 0) so any sourced product from any recommendation surface enters the same pipeline.

**Architecture:** New `product_selections` + `product_selection_events` tables linked via FK to `discovered_products`. Existing `/api/discovery/feedback` is extended to create/auto-close selections alongside its current `user_action` write. A read-only board ships first; writes (drag, broadcast match, cron auto-close) come after. Strategy fresh-search recs get persisted into `discovered_products` (one synthetic `discovery_runs` session per strategy) so they participate in the same feedback model.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (`@supabase/ssr` + service role), `@dnd-kit` for the kanban DnD, `next-intl`, tsx-based smoke test scripts.

**Spec:** `docs/superpowers/specs/2026-05-24-product-selection-pipeline-design.md`

---

## Scope

In: schema + RLS + backfill; the two write paths into `product_selections` (feedback handler extension and explicit board mutations); read-only board + nav badge; broadcast-match dialog; daily cron auto-close; pipeline status chip on existing discovery/strategy cards. Phase 0 unification (FeedbackButtons on `DiscoveredProductsHero.tsx` and fresh-search persistence) is bundled with the pipeline work because Phase 1 is incoherent without it.

Out: sales/revenue tracking, supplier/PO structured fields, multi-broadcast per selection, notifications, insights dashboard, retroactive feedback for past strategy documents. These are explicit Phase 2+ follow-ups in §3 of the spec.

## File Structure

**Create:**

- `supabase/migrations/2026-05-24_product_selections.sql` — tables, indexes, constraints, RLS, backfill.
- `lib/selections/cached.ts` — cache invalidator + tag constants used by selection-mutating endpoints.
- `lib/selections/types.ts` — shared TS types (`SelectionStatus`, `SelectionRow`, board grouping shape).
- `lib/strategy/fresh-search-persist.ts` — helper that creates a `discovery_runs` session and bulk-inserts strategy `fresh_search`/`research` recs into `discovered_products`.
- `app/api/selections/route.ts` — `GET` board data (grouped by status, with filters).
- `app/api/selections/counts/route.ts` — `GET` active count for nav badge.
- `app/api/selections/[id]/move/route.ts` — `POST` stage transition with optimistic lock.
- `app/api/selections/[id]/assign/route.ts` — `POST` assignee change.
- `app/api/selections/[id]/reopen/route.ts` — `POST` reopen closed selection.
- `app/api/selections/[id]/note/route.ts` — `PATCH` inline note edit.
- `app/api/selections/[id]/events/route.ts` — `GET` events timeline.
- `app/api/selections/match-broadcast/route.ts` — `GET` broadcast candidate search.
- `app/api/cron/pipeline-auto-advance/route.ts` — daily JST 03:00 auto-close handler.
- `app/[locale]/(market)/analytics/pipeline/page.tsx` — kanban board (server component shell).
- `components/pipeline/KanbanBoard.tsx` — client component, 4 columns, DnD wiring.
- `components/pipeline/SelectionCard.tsx` — single-card render with stage-specific content.
- `components/pipeline/CardMenu.tsx` — `[···]` dropdown (assign, close, reopen, history).
- `components/pipeline/BroadcastMatchDialog.tsx` — broadcast picker for `scheduled` transition.
- `components/pipeline/EventsTimelineModal.tsx` — history modal.
- `components/pipeline/PipelineStatusChip.tsx` — small chip rendered on discovery/strategy cards.
- `components/pipeline/FiltersBar.tsx` — scope/assignee/search filter row.
- `scripts/test-selections-state-machine.ts` — integration smoke for state transitions + unique index.
- `scripts/test-selections-backfill.ts` — dry-run of the backfill block on a synthetic dataset.
- `scripts/test-strategy-fresh-search-persist.ts` — smoke for fresh-search persistence helper.

**Modify:**

- `app/api/discovery/feedback/route.ts` — on `sourced` add a `product_selections` row + event; on `sourced` toggle-off auto-close if still in `selected`.
- `lib/discovery/cached.ts` — add `'selections:board'` and `'selections:counts'` revalidations to `invalidateDiscoveryAfterMutation` (defensive cross-invalidation).
- `lib/md-strategy.ts` — call `persistStrategyFreshSearch(...)` after Gemini curation; back-fill `discovered_product_id` onto fresh-search recs before the strategy is saved.
- `components/analytics/DiscoveredProductsHero.tsx` — import + render `FeedbackButtons`; render `PipelineStatusChip` when `user_action === 'sourced'`.
- `components/discovery/ProductCard.tsx` — render `PipelineStatusChip` next to existing badges.
- `lib/nav/groups.ts` — add `{ labelKey: 'nav.market.pipeline', href: '/analytics/pipeline' }` to `market.members`; add path prefix.
- `messages/en.json`, `messages/ja.json`, `messages/ko.json` — add `nav.market.pipeline` plus pipeline page strings.
- `vercel.json` — register `/api/cron/pipeline-auto-advance` schedule `0 18 * * *` (UTC; = JST 03:00) and a function entry with `maxDuration: 60`.
- `package.json` — add `test:selections`, `test:strategy-fresh-search` script entries.

---

## Task 1: Migration — tables, RLS, backfill

**Files:**

- Create: `supabase/migrations/2026-05-24_product_selections.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-05-24_product_selections.sql`:

```sql
-- Product Selection Pipeline (spec 2026-05-24)
-- Adds product_selections + product_selection_events with RLS and a
-- backfill of existing discovered_products.user_action='sourced' rows.

BEGIN;

CREATE TABLE IF NOT EXISTS product_selections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_product_id uuid NOT NULL REFERENCES discovered_products(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'selected'
    CHECK (status IN ('selected','sourcing','scheduled','closed')),

  owner_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  assignee_id uuid          REFERENCES profiles(id) ON DELETE SET NULL,

  broadcast_id uuid REFERENCES broadcasts(id) ON DELETE SET NULL,

  closed_reason text CHECK (closed_reason IN ('aired','dropped','postponed')),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES profiles(id),

  sourcing_note  text,
  scheduled_note text,
  closed_note    text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scheduled_requires_anchor
    CHECK (status != 'scheduled'
           OR broadcast_id IS NOT NULL
           OR scheduled_note IS NOT NULL),
  CONSTRAINT closed_requires_reason
    CHECK (status != 'closed'
           OR (closed_reason IS NOT NULL AND closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_selection_per_product
  ON product_selections(discovered_product_id) WHERE status != 'closed';

CREATE INDEX IF NOT EXISTS idx_ps_status_active
  ON product_selections(status, updated_at DESC) WHERE status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ps_owner_active
  ON product_selections(owner_id) WHERE status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ps_assignee_active
  ON product_selections(assignee_id) WHERE status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ps_discovered
  ON product_selections(discovered_product_id);
CREATE INDEX IF NOT EXISTS idx_ps_broadcast
  ON product_selections(broadcast_id) WHERE broadcast_id IS NOT NULL;

CREATE OR REPLACE FUNCTION product_selections_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS product_selections_updated_at_trg ON product_selections;
CREATE TRIGGER product_selections_updated_at_trg
  BEFORE UPDATE ON product_selections
  FOR EACH ROW EXECUTE FUNCTION product_selections_set_updated_at();

CREATE TABLE IF NOT EXISTS product_selection_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id uuid NOT NULL REFERENCES product_selections(id) ON DELETE CASCADE,

  event_type text NOT NULL CHECK (event_type IN (
    'created',
    'status_changed',
    'assignee_changed',
    'broadcast_linked',
    'broadcast_unlinked',
    'closed',
    'reopened',
    'note_updated'
  )),

  from_status      text,
  to_status        text,
  from_assignee_id uuid REFERENCES profiles(id),
  to_assignee_id   uuid REFERENCES profiles(id),
  broadcast_id     uuid REFERENCES broadcasts(id),
  closed_reason    text,
  note             text,

  actor_id  uuid REFERENCES profiles(id),
  is_system boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pse_selection_time
  ON product_selection_events(selection_id, created_at DESC);

-- RLS
ALTER TABLE product_selections       ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_selection_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ps_select  ON product_selections;
DROP POLICY IF EXISTS ps_write   ON product_selections;
DROP POLICY IF EXISTS pse_select ON product_selection_events;
DROP POLICY IF EXISTS pse_insert ON product_selection_events;

CREATE POLICY ps_select ON product_selections
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ps_write ON product_selections
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p
                 WHERE p.id = auth.uid() AND p.role IN ('member','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p
                      WHERE p.id = auth.uid() AND p.role IN ('member','admin')));

CREATE POLICY pse_select ON product_selection_events
  FOR SELECT TO authenticated USING (true);

CREATE POLICY pse_insert ON product_selection_events
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p
                      WHERE p.id = auth.uid() AND p.role IN ('member','admin')));

-- Backfill existing sourced rows whose original author is recoverable.
INSERT INTO product_selections (
  discovered_product_id, status, owner_id, created_at, updated_at
)
SELECT
  dp.id,
  'selected',
  (SELECT pf.user_id FROM product_feedback pf
     WHERE pf.discovered_product_id = dp.id AND pf.action = 'sourced'
     ORDER BY pf.created_at DESC LIMIT 1),
  COALESCE(dp.action_at, dp.created_at),
  COALESCE(dp.action_at, dp.created_at)
FROM discovered_products dp
WHERE dp.user_action = 'sourced'
  AND EXISTS (
    SELECT 1 FROM product_feedback pf
    WHERE pf.discovered_product_id = dp.id AND pf.action = 'sourced'
  )
ON CONFLICT DO NOTHING;

INSERT INTO product_selection_events (
  selection_id, event_type, to_status, actor_id, is_system, note
)
SELECT id, 'created', 'selected', owner_id, true,
       'Backfilled from existing discovered_products.user_action=''sourced'''
FROM product_selections
WHERE NOT EXISTS (
  SELECT 1 FROM product_selection_events e
  WHERE e.selection_id = product_selections.id AND e.event_type = 'created'
);

COMMIT;
```

- [ ] **Step 2: Apply locally and verify**

Run the migration against the project's local Supabase. Exact command depends on the operator's setup — Supabase CLI users use `supabase db push` against the linked project; psql users pipe the file in. Confirm by running:

```sql
SELECT count(*) FROM product_selections;
SELECT count(*) FROM product_selection_events;
SELECT count(*) FROM discovered_products WHERE user_action='sourced';
```

The first two should approximately equal the third (within the `product_feedback`-author-recoverable subset). The events table should have exactly one `created` row per selection.

- [ ] **Step 3: Confirm RLS enforcement smoke**

From a service-role client INSERT works. From a logged-in `viewer` profile, SELECT works but INSERT into `product_selections` returns a policy violation. Document the test commands in this issue if running manually.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-24_product_selections.sql
git commit -m "feat(selections): add product_selections + events schema + RLS + backfill"
```

## Task 2: Shared types + cache helper

**Files:**

- Create: `lib/selections/types.ts`
- Create: `lib/selections/cached.ts`

- [ ] **Step 1: Write the shared types**

Create `lib/selections/types.ts`:

```ts
import "server-only";

export type SelectionStatus = "selected" | "sourcing" | "scheduled" | "closed";
export type ClosedReason = "aired" | "dropped" | "postponed";

export interface SelectionRow {
  id: string;
  discovered_product_id: string;
  status: SelectionStatus;
  owner_id: string;
  assignee_id: string | null;
  broadcast_id: string | null;
  closed_reason: ClosedReason | null;
  closed_at: string | null;
  closed_by: string | null;
  sourcing_note: string | null;
  scheduled_note: string | null;
  closed_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardCard extends SelectionRow {
  product: {
    name: string;
    thumbnail_url: string | null;
    price_jpy: number | null;
    category: string | null;
    source: string | null;
    tv_fit_score: number | null;
    product_url: string;
  };
  broadcast: {
    channel: string;
    air_date: string;
    start_time: string | null;
    program_title: string;
  } | null;
  owner: { display_name: string | null; email: string } | null;
  assignee: { display_name: string | null; email: string } | null;
}

export interface BoardData {
  selected: BoardCard[];
  sourcing: BoardCard[];
  scheduled: BoardCard[];
  closed: BoardCard[];
}
```

- [ ] **Step 2: Write the cache helper**

Create `lib/selections/cached.ts`:

```ts
import "server-only";
import { revalidateTag } from "next/cache";

export const SELECTIONS_BOARD_TAG = "selections:board";
export const SELECTIONS_COUNTS_TAG = "selections:counts";

const TAGS = [SELECTIONS_BOARD_TAG, SELECTIONS_COUNTS_TAG] as const;

export function invalidateSelectionsAfterMutation(source: string): void {
  for (const tag of TAGS) {
    try {
      revalidateTag(tag, "max");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[cache] revalidateTag failed", { source, tag, error: msg });
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/selections/types.ts lib/selections/cached.ts
git commit -m "feat(selections): shared types and cache invalidator"
```

## Task 3: Phase 0 — cross-tag invalidation in discovery cache

**Files:**

- Modify: `lib/discovery/cached.ts`

- [ ] **Step 1: Add selections tags to discovery mutation invalidator**

Open `lib/discovery/cached.ts`. Find `MUTATION_TAGS` (around line 364) and extend it with the two selections tags so that any discovery mutation refreshes the board too (the pipeline chip on a discovery card depends on `discovered_products` joined with `product_selections`).

```ts
const MUTATION_TAGS = [
  "discovery:home_shopping",
  "discovery:live_commerce",
  "discovery:insights",
  "discovery:history",
  "discovery:selections",
  "selections:board",
  "selections:counts",
] as const;
```

- [ ] **Step 2: Commit**

```bash
git add lib/discovery/cached.ts
git commit -m "feat(selections): cross-invalidate selections tags from discovery mutations"
```

## Task 4: Phase 0 — fresh-search persistence helper

**Files:**

- Create: `lib/strategy/fresh-search-persist.ts`
- Create: `scripts/test-strategy-fresh-search-persist.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the persistence helper**

Create `lib/strategy/fresh-search-persist.ts`:

```ts
import "server-only";
import { getServiceClient } from "@/lib/supabase";
import { normalizeName } from "@/lib/discovery/exclusion";

export type FreshSearchCandidate = {
  name: string;
  source: "rakuten" | "brave" | "tv_channel" | "web" | "other";
  source_url: string;
  estimated_price_jpy?: string;
  tv_channel_source?: string | null;
  pool_source?: "discovery_pool" | "fresh_search" | "seed" | "research";
  discovered_product_id?: string;
};

export interface PersistResult {
  /** Map of source_url -> discovered_products.id created or re-used. */
  idByUrl: Map<string, string>;
  /** Synthetic discovery_runs.id created for this strategy invocation. */
  sessionId: string;
}

const SOURCE_TO_DP_SOURCE: Record<string, string> = {
  rakuten: "rakuten",
  brave: "brave",
  tv_channel: "tv_channel",
  web: "brave",
  other: "other",
};

function parsePriceJpy(input: string | undefined | null): number | null {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * Persist strategy fresh_search / research recommendations into
 * discovered_products so they share the same feedback model as pool-sourced
 * recs. Creates a single synthetic discovery_runs row per strategy invocation.
 *
 * Only items where pool_source is 'fresh_search' or 'research' AND
 * discovered_product_id is missing are inserted. Pool/seed items are passed
 * through unchanged.
 *
 * Idempotency: relies on discovered_products UNIQUE(session_id, product_url).
 * Within a single strategy, the same URL is collapsed.
 */
export async function persistStrategyFreshSearch(
  items: FreshSearchCandidate[],
  opts: { strategyId: string; context: "home_shopping" | "live_commerce" },
): Promise<PersistResult> {
  const targets = items.filter(
    (p) =>
      !p.discovered_product_id &&
      (p.pool_source === "fresh_search" || p.pool_source === "research") &&
      !!p.name &&
      !!p.source_url,
  );

  const idByUrl = new Map<string, string>();
  if (targets.length === 0) {
    return { idByUrl, sessionId: "" };
  }

  const sb = getServiceClient();
  const targetCount = targets.length;

  const { data: session, error: sessErr } = await sb
    .from("discovery_runs")
    .insert({
      status: "completed",
      target_count: targetCount,
      produced_count: targetCount,
      exploration_ratio: 0,
      iterations: 1,
      context: opts.context,
    })
    .select("id")
    .single();

  if (sessErr || !session) {
    throw new Error(
      `[fresh-search-persist] could not create session: ${sessErr?.message}`,
    );
  }

  const seen = new Set<string>();
  const rows = targets
    .filter((p) => {
      if (seen.has(p.source_url)) return false;
      seen.add(p.source_url);
      return true;
    })
    .map((p) => ({
      session_id: session.id,
      name: p.name,
      name_normalized: normalizeName(p.name),
      product_url: p.source_url,
      thumbnail_url: null,
      price_jpy: parsePriceJpy(p.estimated_price_jpy),
      category: null,
      seed_keyword: `strategy:${opts.strategyId}`,
      source: SOURCE_TO_DP_SOURCE[p.source] ?? "other",
      tv_channel_source: p.tv_channel_source ?? null,
      tv_fit_score: 0,
      tv_fit_reason: "Strategy fresh_search rec — score not computed",
      track: "exploration" as const,
    }));

  const { data: inserted, error: insErr } = await sb
    .from("discovered_products")
    .insert(rows)
    .select("id, product_url");

  if (insErr) {
    throw new Error(
      `[fresh-search-persist] bulk insert failed: ${insErr.message}`,
    );
  }

  for (const row of inserted ?? []) {
    if (row.product_url) idByUrl.set(row.product_url as string, row.id as string);
  }

  return { idByUrl, sessionId: session.id };
}
```

- [ ] **Step 2: Write the smoke test**

Create `scripts/test-strategy-fresh-search-persist.ts`:

```ts
/**
 * Smoke for lib/strategy/fresh-search-persist. Hits a real Supabase.
 * Inserts two recs, asserts they get ids back and that a session row was
 * created. Cleans up after itself.
 *
 * Run: npm run test:strategy-fresh-search
 */
import { persistStrategyFreshSearch } from "../lib/strategy/fresh-search-persist";
import { getServiceClient } from "../lib/supabase";

async function main() {
  const strategyId = `smoke-${Date.now()}`;
  const items = [
    {
      name: "Smoke Product A",
      source: "rakuten" as const,
      source_url: `https://example.test/${strategyId}/a`,
      estimated_price_jpy: "¥3,980",
      pool_source: "fresh_search" as const,
    },
    {
      name: "Smoke Product B",
      source: "brave" as const,
      source_url: `https://example.test/${strategyId}/b`,
      pool_source: "research" as const,
    },
    {
      name: "Already linked",
      source: "rakuten" as const,
      source_url: `https://example.test/${strategyId}/c`,
      pool_source: "discovery_pool" as const,
      discovered_product_id: "00000000-0000-0000-0000-000000000000",
    },
  ];

  const res = await persistStrategyFreshSearch(items, {
    strategyId,
    context: "home_shopping",
  });

  let failures = 0;
  function check(cond: boolean, label: string) {
    if (cond) console.log(`PASS: ${label}`);
    else {
      console.error(`FAIL: ${label}`);
      failures++;
    }
  }

  check(res.idByUrl.size === 2, "two new ids returned");
  check(res.idByUrl.has(items[0].source_url), "rec A id is mapped");
  check(res.idByUrl.has(items[1].source_url), "rec B id is mapped");
  check(!!res.sessionId, "synthetic session id returned");

  // Cleanup
  const sb = getServiceClient();
  if (res.sessionId) {
    await sb.from("discovered_products").delete().eq("session_id", res.sessionId);
    await sb.from("discovery_runs").delete().eq("id", res.sessionId);
  }

  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Add script to package.json**

Open `package.json` and add under `scripts`:

```json
"test:strategy-fresh-search": "tsx scripts/test-strategy-fresh-search-persist.ts"
```

- [ ] **Step 4: Run the test**

```bash
npm run test:strategy-fresh-search
```

Expected: 4 PASS lines and exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/strategy/fresh-search-persist.ts scripts/test-strategy-fresh-search-persist.ts package.json
git commit -m "feat(strategy): persist fresh_search recs into discovered_products"
```

## Task 5: Phase 0 — wire persistence into md-strategy

**Files:**

- Modify: `lib/md-strategy.ts`

- [ ] **Step 1: Locate the curation result handoff**

Find the place in `lib/md-strategy.ts` where Gemini curation produces the final list of `recommendedProducts` and the strategy is about to be persisted. The natural insertion point is right after `attributeSource(...)` enriches the items but before the strategy is saved. Identify the `strategyId` and `context` available there. If they are not in scope at that frame, thread them down from the route handler — `app/api/analytics/md-strategy/route.ts` — by passing the strategy id and context into `fetchStrategyContext`.

- [ ] **Step 2: Call the persistence helper**

After the curation result is built and before the strategy document is saved, run:

```ts
import { persistStrategyFreshSearch } from "@/lib/strategy/fresh-search-persist";

// recommendedProducts: the array assembled from pool + fresh_search + seed + research
try {
  const { idByUrl } = await persistStrategyFreshSearch(
    recommendedProducts.map((p) => ({
      name: p.name,
      source: p.source,
      source_url: p.source_url,
      estimated_price_jpy: p.estimated_price_jpy,
      tv_channel_source: p.tv_channel_source,
      pool_source: p.pool_source,
      discovered_product_id: p.discovered_product_id,
    })),
    { strategyId, context: strategyContext },
  );
  for (const p of recommendedProducts) {
    if (!p.discovered_product_id) {
      const mapped = idByUrl.get(p.source_url);
      if (mapped) p.discovered_product_id = mapped;
    }
  }
} catch (err) {
  console.warn("[md-strategy] fresh-search persistence failed (non-fatal):", err);
}
```

This is best-effort: a failure leaves `discovered_product_id` undefined on those recs and the UI will not render `FeedbackButtons` for them — strictly worse than success, but never blocks strategy generation.

- [ ] **Step 3: Verify with an end-to-end run**

Trigger a strategy generation that is known to produce `fresh_search` items (e.g. seed something Discovery has not seen). After completion, in Supabase confirm:

- A new `discovery_runs` row exists with `target_count = N`, status `completed`, the strategy id encoded in the products' `seed_keyword`.
- The strategy document JSONB (`md_strategies.product_selection`) carries `discovered_product_id` on every fresh-search rec.

- [ ] **Step 4: Commit**

```bash
git add lib/md-strategy.ts
git commit -m "feat(strategy): persist fresh_search recs at strategy generation time"
```

## Task 6: Phase 0 — FeedbackButtons on the strategy card

**Files:**

- Modify: `components/analytics/DiscoveredProductsHero.tsx`

- [ ] **Step 1: Wire the component**

In `components/analytics/DiscoveredProductsHero.tsx`:

1. Import the button at the top of the file:

```ts
import { FeedbackButtons, type FeedbackState } from "@/components/discovery/FeedbackButtons";
```

2. Inside `ProductCard`, add local state for the current feedback and render the button row between the "商品ページを確認" link and the sales-strategy expansion section. The recommendation's `user_action` is not currently in the strategy JSONB; for v1 the card starts uncontrolled and reflects the server response after the user clicks.

```tsx
const [feedback, setFeedback] = useState<FeedbackState>(null);

// ... existing JSX ...

{p.discovered_product_id && (
  <div className="mt-3">
    <FeedbackButtons
      productId={p.discovered_product_id}
      current={feedback}
      onUpdate={(next) => setFeedback(next)}
    />
  </div>
)}
```

3. When `p.discovered_product_id` is undefined (e.g. fresh-search persistence failed earlier or this is a legacy strategy document), the buttons are simply omitted.

- [ ] **Step 2: Manual smoke**

Open `/[locale]/analytics/strategy/expansion/<id>` for a strategy that contains `discovery_pool` and `fresh_search` items. Confirm:

- All pool-sourced cards show the 4 buttons.
- After Task 5, fresh-search cards also show the 4 buttons (`discovered_product_id` populated).
- Clicking `sourced` returns 200 and the button turns green.

- [ ] **Step 3: Commit**

```bash
git add components/analytics/DiscoveredProductsHero.tsx
git commit -m "feat(analytics): FeedbackButtons on strategy expansion card"
```

## Task 7: GET /api/selections + counts

**Files:**

- Create: `app/api/selections/route.ts`
- Create: `app/api/selections/counts/route.ts`

- [ ] **Step 1: Write the board endpoint**

Create `app/api/selections/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import type { BoardCard, BoardData, SelectionStatus } from "@/lib/selections/types";

export const maxDuration = 10;

const STATUSES: SelectionStatus[] = ["selected", "sourcing", "scheduled", "closed"];

export async function GET(req: NextRequest) {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope"); // 'mine_owned' | 'mine_assigned' | null
  const assigneeFilter = url.searchParams.get("assignee");
  const q = url.searchParams.get("q");
  const includeClosed = url.searchParams.get("includeClosed") === "1";

  const sb = getServiceClient();

  let query = sb
    .from("product_selections")
    .select(`
      id, discovered_product_id, status, owner_id, assignee_id, broadcast_id,
      closed_reason, closed_at, closed_by, sourcing_note, scheduled_note,
      closed_note, created_at, updated_at,
      product:discovered_products!inner(
        name, thumbnail_url, price_jpy, category, source, tv_fit_score, product_url
      ),
      broadcast:broadcasts(channel, air_date, start_time, program_title),
      owner:profiles!product_selections_owner_id_fkey(display_name, email),
      assignee:profiles!product_selections_assignee_id_fkey(display_name, email)
    `)
    .order("updated_at", { ascending: false });

  if (!includeClosed) {
    query = query.neq("status", "closed");
  } else {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    query = query.or(`status.neq.closed,and(status.eq.closed,closed_at.gte.${sevenDaysAgo})`);
  }

  if (scope === "mine_owned") query = query.eq("owner_id", auth.user.id);
  if (scope === "mine_assigned") query = query.eq("assignee_id", auth.user.id);
  if (assigneeFilter && assigneeFilter !== "all") query = query.eq("assignee_id", assigneeFilter);
  if (q) query = query.ilike("product.name", `%${q}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const board: BoardData = { selected: [], sourcing: [], scheduled: [], closed: [] };
  for (const row of data ?? []) {
    const card = row as unknown as BoardCard;
    if (STATUSES.includes(card.status)) board[card.status].push(card);
  }

  return NextResponse.json({ board });
}
```

- [ ] **Step 2: Write the counts endpoint**

Create `app/api/selections/counts/route.ts`:

```ts
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 5;

export async function GET() {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;

  const sb = getServiceClient();
  const { data, error } = await sb
    .from("product_selections")
    .select("status")
    .neq("status", "closed");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const counts = { selected: 0, sourcing: 0, scheduled: 0, total: 0 };
  for (const row of data ?? []) {
    counts.total++;
    if (row.status === "selected") counts.selected++;
    else if (row.status === "sourcing") counts.sourcing++;
    else if (row.status === "scheduled") counts.scheduled++;
  }
  return NextResponse.json({ counts });
}
```

- [ ] **Step 3: Manual smoke**

Hit each endpoint with a logged-in member session. `GET /api/selections` returns `{ board: { selected: [...], sourcing: [...], scheduled: [...], closed: [...] } }`. `GET /api/selections/counts` returns `{ counts: { selected, sourcing, scheduled, total } }`.

- [ ] **Step 4: Commit**

```bash
git add app/api/selections/route.ts app/api/selections/counts/route.ts
git commit -m "feat(api/selections): board + counts read endpoints"
```

## Task 8: Pipeline page (read-only)

**Files:**

- Create: `app/[locale]/(market)/analytics/pipeline/page.tsx`
- Create: `components/pipeline/KanbanBoard.tsx`
- Create: `components/pipeline/SelectionCard.tsx`
- Create: `components/pipeline/FiltersBar.tsx`

- [ ] **Step 1: Write the server page**

Create `app/[locale]/(market)/analytics/pipeline/page.tsx`:

```tsx
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import type { BoardData, BoardCard } from "@/lib/selections/types";
import { KanbanBoard } from "@/components/pipeline/KanbanBoard";

export const dynamic = "force-dynamic";

async function loadBoard(): Promise<BoardData> {
  const sb = getServiceClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from("product_selections")
    .select(`
      id, discovered_product_id, status, owner_id, assignee_id, broadcast_id,
      closed_reason, closed_at, closed_by, sourcing_note, scheduled_note,
      closed_note, created_at, updated_at,
      product:discovered_products!inner(name, thumbnail_url, price_jpy, category, source, tv_fit_score, product_url),
      broadcast:broadcasts(channel, air_date, start_time, program_title),
      owner:profiles!product_selections_owner_id_fkey(display_name, email),
      assignee:profiles!product_selections_assignee_id_fkey(display_name, email)
    `)
    .or(`status.neq.closed,and(status.eq.closed,closed_at.gte.${sevenDaysAgo})`)
    .order("updated_at", { ascending: false });

  const board: BoardData = { selected: [], sourcing: [], scheduled: [], closed: [] };
  for (const row of (data ?? []) as unknown as BoardCard[]) {
    if (board[row.status]) board[row.status].push(row);
  }
  return board;
}

export default async function PipelinePage() {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;

  const t = await getTranslations("pipeline");
  const board = await loadBoard();
  const canWrite = auth.role !== "viewer";

  return (
    <main className="flex-1 p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>
      <KanbanBoard initialBoard={board} canWrite={canWrite} />
    </main>
  );
}
```

- [ ] **Step 2: Write the kanban shell (read-only, no DnD yet)**

Create `components/pipeline/KanbanBoard.tsx`:

```tsx
"use client";
import { useState } from "react";
import type { BoardData, SelectionStatus } from "@/lib/selections/types";
import { SelectionCard } from "./SelectionCard";

const COLUMNS: Array<{ status: SelectionStatus; titleKey: string; tone: string }> = [
  { status: "selected", titleKey: "selected", tone: "bg-neutral-100 dark:bg-neutral-900/40" },
  { status: "sourcing", titleKey: "sourcing", tone: "bg-amber-100 dark:bg-amber-900/30" },
  { status: "scheduled", titleKey: "scheduled", tone: "bg-blue-100 dark:bg-blue-900/30" },
  { status: "closed", titleKey: "closed", tone: "bg-emerald-100 dark:bg-emerald-900/30" },
];

const LABELS: Record<SelectionStatus, string> = {
  selected: "선택됨",
  sourcing: "소싱중",
  scheduled: "방송예정",
  closed: "종료(최근 7일)",
};

export function KanbanBoard({
  initialBoard,
  canWrite,
}: {
  initialBoard: BoardData;
  canWrite: boolean;
}) {
  const [board] = useState<BoardData>(initialBoard);

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {COLUMNS.map((col) => (
        <section key={col.status} className={`rounded-xl p-3 ${col.tone}`}>
          <header className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">{LABELS[col.status]}</h2>
            <span className="text-xs text-muted-foreground">{board[col.status].length}</span>
          </header>
          <div className="flex flex-col gap-2">
            {board[col.status].map((card) => (
              <SelectionCard key={card.id} card={card} canWrite={canWrite} />
            ))}
            {board[col.status].length === 0 && (
              <p className="text-xs text-muted-foreground italic py-4 text-center">
                비어 있음
              </p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write the card**

Create `components/pipeline/SelectionCard.tsx`:

```tsx
"use client";
import Image from "next/image";
import type { BoardCard } from "@/lib/selections/types";

export function SelectionCard({ card, canWrite }: { card: BoardCard; canWrite: boolean }) {
  const p = card.product;
  return (
    <article className="bg-card border border-border rounded-lg p-3 shadow-sm">
      <div className="flex gap-2">
        {p.thumbnail_url && (
          <div className="w-12 h-12 relative shrink-0 rounded overflow-hidden">
            <Image src={p.thumbnail_url} alt={p.name} fill sizes="48px" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold line-clamp-2">{p.name}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {p.price_jpy ? `¥${p.price_jpy.toLocaleString()}` : "—"}
            {typeof p.tv_fit_score === "number" && (
              <span className="ml-1">· TV適 {p.tv_fit_score}</span>
            )}
          </p>
        </div>
      </div>
      {card.status === "scheduled" && (
        <p className="text-[11px] mt-2 px-2 py-1 bg-blue-50 dark:bg-blue-950/40 rounded">
          {card.broadcast
            ? `📺 ${card.broadcast.channel.toUpperCase()} · ${card.broadcast.air_date}${card.broadcast.start_time ? ` ${card.broadcast.start_time}` : ""}`
            : `📝 ${card.scheduled_note ?? "수동 입력"}`}
        </p>
      )}
      {card.status === "closed" && (
        <p className="text-[11px] mt-2 px-2 py-1 bg-emerald-50 dark:bg-emerald-950/40 rounded">
          {card.closed_reason === "aired" && `✅ 방송완료 ${card.closed_at?.slice(0, 10) ?? ""}`}
          {card.closed_reason === "dropped" && `🚫 드롭 ${card.closed_at?.slice(0, 10) ?? ""}`}
          {card.closed_reason === "postponed" && `⏸ 보류 ${card.closed_at?.slice(0, 10) ?? ""}`}
        </p>
      )}
      {card.status === "sourcing" && card.sourcing_note && (
        <p className="text-[11px] mt-2 px-2 py-1 bg-amber-50 dark:bg-amber-950/40 rounded line-clamp-3">
          {card.sourcing_note}
        </p>
      )}
      <footer className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
        <span>
          {(card.owner?.display_name ?? card.owner?.email)?.slice(0, 12)}
          {card.assignee && card.assignee_id !== card.owner_id && (
            <> → {(card.assignee.display_name ?? card.assignee.email).slice(0, 12)}</>
          )}
        </span>
        {!canWrite && <span>읽기 전용</span>}
      </footer>
    </article>
  );
}
```

- [ ] **Step 4: Visit the page**

`/[locale]/analytics/pipeline` should render with the 4 columns and any backfilled cards. Empty columns show "비어 있음".

- [ ] **Step 5: Commit**

```bash
git add app/[locale]/\(market\)/analytics/pipeline/page.tsx components/pipeline/KanbanBoard.tsx components/pipeline/SelectionCard.tsx
git commit -m "feat(pipeline): read-only kanban board at /analytics/pipeline"
```

## Task 9: Nav entry + translations + badge

**Files:**

- Modify: `lib/nav/groups.ts`
- Modify: `messages/en.json`, `messages/ja.json`, `messages/ko.json`
- Modify: `components/Navbar.tsx`

- [ ] **Step 1: Add the nav member**

Open `lib/nav/groups.ts`. In the `market` group:

```ts
pathPrefixes: ['/broadcasts', '/analytics/discovery', '/analytics/strategy', '/analytics/pipeline'],
members: [
  { labelKey: 'nav.market.broadcasts', href: '/broadcasts' },
  { labelKey: 'nav.market.discovery', href: '/analytics/discovery' },
  { labelKey: 'nav.market.strategy', href: '/analytics/strategy' },
  { labelKey: 'nav.market.pipeline', href: '/analytics/pipeline' },
],
```

- [ ] **Step 2: Add translations**

In each of `messages/en.json`, `messages/ja.json`, `messages/ko.json` add under `nav.market`:

```json
"pipeline": "Pipeline"
```

For `ja.json` use `"パイプライン"`, for `ko.json` use `"파이프라인"`.

Add a `pipeline` section to each file with:

```json
"pipeline": {
  "title": "Pipeline",        // / "パイプライン" / "파이프라인"
  "subtitle": "Selected products and their stages"  // localize
}
```

- [ ] **Step 3: Wire the badge in Navbar**

Open `components/Navbar.tsx`. Find where market members are rendered. Add a server-side count fetch — the simplest approach is a small inline server component that reads from `product_selections`:

```tsx
// inside the navbar, around the pipeline member:
{member.href === "/analytics/pipeline" && <PipelineCountBadge />}
```

And at the bottom of the file (or in a new file imported by Navbar):

```tsx
async function PipelineCountBadge() {
  "use server"; // or simply rely on the parent server component
  // If Navbar is a client component, fetch counts client-side instead:
  const res = await fetch(`/api/selections/counts`, { cache: "no-store" });
  if (!res.ok) return null;
  const { counts } = await res.json();
  return counts.total > 0 ? (
    <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-300">
      {counts.total}
    </span>
  ) : null;
}
```

If `Navbar.tsx` is a client component, replace the implementation above with a `useEffect` that fetches `/api/selections/counts` and stores the count in state. Whichever shape Navbar already uses, follow it.

- [ ] **Step 4: Manual smoke**

The market group now shows `Pipeline (N)` where N is the count of active selections. Clicking it navigates to `/analytics/pipeline`.

- [ ] **Step 5: Commit**

```bash
git add lib/nav/groups.ts messages/en.json messages/ja.json messages/ko.json components/Navbar.tsx
git commit -m "feat(nav): pipeline entry with active-count badge"
```

## Task 10: Activate selection writes in feedback handler

**Files:**

- Modify: `app/api/discovery/feedback/route.ts`
- Create: `scripts/test-selections-state-machine.ts`
- Modify: `package.json`

- [ ] **Step 1: Extend the feedback handler**

Open `app/api/discovery/feedback/route.ts`. Add the import:

```ts
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";
```

After the existing INSERT/UPDATE Promise.all (the `set` branch, after line 138), add:

```ts
// Pipeline integration: a newly-applied 'sourced' opens a selection.
if (body.action === "sourced") {
  const { data: existingActive } = await sb
    .from("product_selections")
    .select("id, status")
    .eq("discovered_product_id", body.productId)
    .neq("status", "closed")
    .maybeSingle();

  if (!existingActive) {
    const { data: selection, error: selErr } = await sb
      .from("product_selections")
      .insert({
        discovered_product_id: body.productId,
        status: "selected",
        owner_id: auth.user.id,
      })
      .select("id")
      .single();

    if (!selErr && selection) {
      await sb.from("product_selection_events").insert({
        selection_id: selection.id,
        event_type: "created",
        to_status: "selected",
        actor_id: auth.user.id,
      });
    } else if (selErr) {
      console.warn("[feedback] selection create failed:", selErr.message);
    }
  }
}
```

In the toggle-off branch (after the `update` to `discovered_products`, before the `invalidateDiscoveryAfterMutation` call), add:

```ts
// Pipeline integration: toggling sourced off auto-closes the selection
// IF it is still in the initial 'selected' stage. Advanced selections
// stay alive — the operator has invested work into them.
if (body.action === "sourced") {
  const nowIso = new Date().toISOString();
  const { data: stillSelected } = await sb
    .from("product_selections")
    .select("id")
    .eq("discovered_product_id", body.productId)
    .eq("status", "selected")
    .maybeSingle();

  if (stillSelected) {
    const { error: updSelErr } = await sb
      .from("product_selections")
      .update({
        status: "closed",
        closed_reason: "dropped",
        closed_at: nowIso,
        closed_by: auth.user.id,
        closed_note: "sourced toggle removed",
      })
      .eq("id", stillSelected.id)
      .eq("status", "selected");

    if (!updSelErr) {
      await sb.from("product_selection_events").insert([
        {
          selection_id: stillSelected.id,
          event_type: "status_changed",
          from_status: "selected",
          to_status: "closed",
          actor_id: auth.user.id,
        },
        {
          selection_id: stillSelected.id,
          event_type: "closed",
          closed_reason: "dropped",
          actor_id: auth.user.id,
          note: "sourced toggle removed",
        },
      ]);
    } else {
      console.warn("[feedback] auto-close failed:", updSelErr.message);
    }
  }
}
```

Both the `set` branch and the `toggled_off` branch must call `invalidateSelectionsAfterMutation("feedback")` alongside the existing discovery invalidation.

- [ ] **Step 2: Write the state-machine smoke**

Create `scripts/test-selections-state-machine.ts`:

```ts
/**
 * Smoke: state-machine invariants on product_selections.
 * Uses the service client; cleans up after itself.
 *
 * Run: npm run test:selections
 */
import { getServiceClient } from "../lib/supabase";

const sb = getServiceClient();
let failures = 0;

function check(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

async function main() {
  // Setup: ephemeral discovery_run + discovered_product + a profile id.
  const { data: run } = await sb
    .from("discovery_runs")
    .insert({
      status: "completed", target_count: 1, produced_count: 1,
      exploration_ratio: 0, iterations: 1, context: "home_shopping",
    })
    .select("id").single();
  if (!run) throw new Error("could not create discovery_runs");

  const { data: dp } = await sb
    .from("discovered_products")
    .insert({
      session_id: run.id, name: "SM Test", name_normalized: "smtest",
      product_url: `https://example.test/sm/${Date.now()}`,
      source: "other", seed_keyword: "sm-test",
      tv_fit_score: 0, tv_fit_reason: "test", track: "exploration",
    })
    .select("id").single();
  if (!dp) throw new Error("could not create discovered_products");

  const { data: profile } = await sb.from("profiles").select("id").limit(1).single();
  if (!profile) throw new Error("no profile available — seed a profile first");

  // 1. Create a selection.
  const { data: sel } = await sb
    .from("product_selections")
    .insert({ discovered_product_id: dp.id, status: "selected", owner_id: profile.id })
    .select("id").single();
  check(!!sel, "create selection in 'selected'");
  if (!sel) return cleanup(run.id, null);

  // 2. Partial unique — second active selection on same product fails.
  const dupe = await sb
    .from("product_selections")
    .insert({ discovered_product_id: dp.id, status: "selected", owner_id: profile.id });
  check(!!dupe.error, "second active selection rejected by partial unique");

  // 3. scheduled without broadcast_id and without scheduled_note fails.
  const badScheduled = await sb
    .from("product_selections")
    .update({ status: "scheduled" })
    .eq("id", sel.id);
  check(!!badScheduled.error, "scheduled without anchor rejected");

  // 3a. scheduled with a note is allowed.
  const okScheduled = await sb
    .from("product_selections")
    .update({ status: "scheduled", scheduled_note: "manual" })
    .eq("id", sel.id);
  check(!okScheduled.error, "scheduled with scheduled_note accepted");

  // 4. closed without reason fails.
  const badClose = await sb
    .from("product_selections")
    .update({ status: "closed" })
    .eq("id", sel.id);
  check(!!badClose.error, "closed without reason rejected");

  // 4a. closed with reason+at allowed.
  const okClose = await sb
    .from("product_selections")
    .update({ status: "closed", closed_reason: "dropped", closed_at: new Date().toISOString() })
    .eq("id", sel.id);
  check(!okClose.error, "closed with reason accepted");

  // 5. After close, a new active selection on the same product is allowed.
  const reSel = await sb
    .from("product_selections")
    .insert({ discovered_product_id: dp.id, status: "selected", owner_id: profile.id });
  check(!reSel.error, "new selection after close accepted (re-selection)");

  await cleanup(run.id, sel.id);
}

async function cleanup(runId: string, _selectionId: string | null) {
  await sb.from("product_selections").delete().eq("owner_id",
    (await sb.from("profiles").select("id").limit(1).single()).data!.id);
  await sb.from("discovered_products").delete().eq("session_id", runId);
  await sb.from("discovery_runs").delete().eq("id", runId);
}

main()
  .then(() => { if (failures > 0) process.exit(1); })
  .catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Add the test script**

Append to `package.json` scripts:

```json
"test:selections": "tsx scripts/test-selections-state-machine.ts"
```

- [ ] **Step 4: Run the test**

```bash
npm run test:selections
```

Expected: all PASS, exit 0.

- [ ] **Step 5: Manual feedback smoke**

In a logged-in member browser session:

1. Click `sourced` on any uncategorized discovery card. Confirm a row appears in `product_selections` with `status='selected'`.
2. Click `sourced` again on the same card to toggle off. Confirm the selection is now `status='closed'` with `closed_reason='dropped'`.

- [ ] **Step 6: Commit**

```bash
git add app/api/discovery/feedback/route.ts scripts/test-selections-state-machine.ts package.json
git commit -m "feat(api/feedback): open/auto-close selection on sourced toggle"
```

## Task 11: POST /api/selections/:id/move

**Files:**

- Create: `app/api/selections/[id]/move/route.ts`

- [ ] **Step 1: Write the handler**

Create `app/api/selections/[id]/move/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";
import type { SelectionStatus, ClosedReason } from "@/lib/selections/types";

export const maxDuration = 10;

const VALID_TRANSITIONS: Record<SelectionStatus, SelectionStatus[]> = {
  selected:  ["sourcing", "closed"],
  sourcing:  ["selected", "scheduled", "closed"],
  scheduled: ["sourcing", "closed"],
  closed:    [], // use /reopen
};

interface MoveBody {
  to_status: SelectionStatus;
  broadcast_id?: string | null;
  scheduled_note?: string | null;
  closed_reason?: ClosedReason | null;
  closed_note?: string | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const sb = getServiceClient();
  const { data: current } = await sb
    .from("product_selections")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  const allowed = VALID_TRANSITIONS[current.status as SelectionStatus] ?? [];
  if (!allowed.includes(body.to_status)) {
    return NextResponse.json(
      { error: `transition ${current.status} -> ${body.to_status} not allowed` },
      { status: 400 },
    );
  }

  const patch: Record<string, unknown> = { status: body.to_status };
  const events: Array<Record<string, unknown>> = [];

  if (body.to_status === "scheduled") {
    if (!body.broadcast_id && !body.scheduled_note) {
      return NextResponse.json(
        { error: "scheduled requires broadcast_id or scheduled_note" },
        { status: 400 },
      );
    }
    if (body.broadcast_id) patch.broadcast_id = body.broadcast_id;
    if (body.scheduled_note !== undefined) patch.scheduled_note = body.scheduled_note;
    if (body.broadcast_id) {
      events.push({
        event_type: "broadcast_linked",
        broadcast_id: body.broadcast_id,
        actor_id: auth.user.id,
      });
    }
  }

  if (body.to_status === "closed") {
    if (!body.closed_reason) {
      return NextResponse.json(
        { error: "closed requires closed_reason" },
        { status: 400 },
      );
    }
    patch.closed_reason = body.closed_reason;
    patch.closed_at = new Date().toISOString();
    patch.closed_by = auth.user.id;
    if (body.closed_note !== undefined) patch.closed_note = body.closed_note;
    events.push({
      event_type: "closed",
      closed_reason: body.closed_reason,
      actor_id: auth.user.id,
      note: body.closed_note ?? null,
    });
  }

  events.unshift({
    event_type: "status_changed",
    from_status: current.status,
    to_status: body.to_status,
    actor_id: auth.user.id,
  });

  // Optimistic lock: only apply if the row is still in the expected from-state.
  const { data: updated, error: updErr } = await sb
    .from("product_selections")
    .update(patch)
    .eq("id", id)
    .eq("status", current.status)
    .select("id")
    .maybeSingle();

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (!updated)
    return NextResponse.json(
      { error: "stale — selection moved by someone else; refresh and retry" },
      { status: 409 },
    );

  for (const e of events) {
    await sb.from("product_selection_events").insert({ selection_id: id, ...e });
  }

  invalidateSelectionsAfterMutation("move");
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Manual smoke**

`curl -X POST /api/selections/<id>/move -H 'Content-Type: application/json' -d '{"to_status":"sourcing"}'` against a selection currently `selected` should return 200 and update the row. Trying to move a `closed` row returns 400. Trying to move to `scheduled` without either field returns 400.

- [ ] **Step 3: Commit**

```bash
git add app/api/selections/\[id\]/move/route.ts
git commit -m "feat(api/selections): stage transition with optimistic lock"
```

## Task 12: POST /api/selections/:id/{assign, reopen, note} + events

**Files:**

- Create: `app/api/selections/[id]/assign/route.ts`
- Create: `app/api/selections/[id]/reopen/route.ts`
- Create: `app/api/selections/[id]/note/route.ts`
- Create: `app/api/selections/[id]/events/route.ts`

- [ ] **Step 1: Write the assign handler**

Create `app/api/selections/[id]/assign/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";

export const maxDuration = 5;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { assignee_id } = (await req.json()) as { assignee_id: string | null };

  const sb = getServiceClient();
  const { data: prev } = await sb
    .from("product_selections")
    .select("assignee_id")
    .eq("id", id)
    .maybeSingle();
  if (!prev) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { error: updErr } = await sb
    .from("product_selections")
    .update({ assignee_id })
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await sb.from("product_selection_events").insert({
    selection_id: id,
    event_type: "assignee_changed",
    from_assignee_id: prev.assignee_id,
    to_assignee_id: assignee_id,
    actor_id: auth.user.id,
  });

  invalidateSelectionsAfterMutation("assign");
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Write the reopen handler**

Create `app/api/selections/[id]/reopen/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";

export const maxDuration = 5;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { note } = (await req.json().catch(() => ({}))) as { note?: string };

  const sb = getServiceClient();
  const { data: row } = await sb
    .from("product_selections")
    .select("id, status, discovered_product_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.status !== "closed")
    return NextResponse.json({ error: "only closed selections can reopen" }, { status: 400 });

  // Prevent reopen if another active selection has since taken over.
  const { data: blocker } = await sb
    .from("product_selections")
    .select("id")
    .eq("discovered_product_id", row.discovered_product_id)
    .neq("status", "closed")
    .maybeSingle();
  if (blocker)
    return NextResponse.json(
      { error: "another active selection exists for this product" },
      { status: 409 },
    );

  const { error: updErr } = await sb
    .from("product_selections")
    .update({
      status: "sourcing",
      closed_reason: null,
      closed_at: null,
      closed_by: null,
      closed_note: null,
    })
    .eq("id", id)
    .eq("status", "closed");
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await sb.from("product_selection_events").insert([
    { selection_id: id, event_type: "reopened", actor_id: auth.user.id, note: note ?? null },
    {
      selection_id: id, event_type: "status_changed",
      from_status: "closed", to_status: "sourcing", actor_id: auth.user.id,
    },
  ]);

  invalidateSelectionsAfterMutation("reopen");
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Write the note handler**

Create `app/api/selections/[id]/note/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";

export const maxDuration = 5;
const VALID_FIELDS = new Set(["sourcing_note", "scheduled_note", "closed_note"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { field, value } = (await req.json()) as { field: string; value: string | null };

  if (!VALID_FIELDS.has(field))
    return NextResponse.json({ error: "invalid field" }, { status: 400 });

  const sb = getServiceClient();
  const { error: updErr } = await sb
    .from("product_selections")
    .update({ [field]: value })
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await sb.from("product_selection_events").insert({
    selection_id: id,
    event_type: "note_updated",
    actor_id: auth.user.id,
    note: `${field}: ${(value ?? "").slice(0, 120)}`,
  });

  invalidateSelectionsAfterMutation("note");
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Write the events GET handler**

Create `app/api/selections/[id]/events/route.ts`:

```ts
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 5;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const sb = getServiceClient();

  const { data, error } = await sb
    .from("product_selection_events")
    .select(`
      id, event_type, from_status, to_status, from_assignee_id, to_assignee_id,
      broadcast_id, closed_reason, note, is_system, created_at,
      actor:profiles(display_name, email)
    `)
    .eq("selection_id", id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ events: data ?? [] });
}
```

- [ ] **Step 5: Commit**

```bash
git add app/api/selections/\[id\]/assign/route.ts app/api/selections/\[id\]/reopen/route.ts app/api/selections/\[id\]/note/route.ts app/api/selections/\[id\]/events/route.ts
git commit -m "feat(api/selections): assign, reopen, note, events"
```

## Task 13: GET /api/selections/match-broadcast

**Files:**

- Create: `app/api/selections/match-broadcast/route.ts`

- [ ] **Step 1: Write the handler**

Create `app/api/selections/match-broadcast/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 5;

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[\s　【】\[\]（）()「」『』・,．.、。!?！？]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const url = new URL(req.url);
  const productName = url.searchParams.get("productName") ?? "";
  const channel = url.searchParams.get("channel");
  const from = url.searchParams.get("from"); // YYYY-MM-DD
  const to = url.searchParams.get("to");

  if (!productName)
    return NextResponse.json({ error: "productName required" }, { status: 400 });

  const sb = getServiceClient();
  let q = sb
    .from("broadcasts")
    .select("id, channel, air_date, start_time, program_title")
    .order("air_date", { ascending: true })
    .limit(80);

  if (channel && channel !== "all") q = q.eq("channel", channel);
  if (from) q = q.gte("air_date", from);
  if (to) q = q.lte("air_date", to);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ranked = (data ?? [])
    .map((row) => ({ ...row, score: similarity(productName, row.program_title) }))
    .sort((a, b) => b.score - a.score);

  return NextResponse.json({
    suggestions: ranked.filter((r) => r.score > 0.15).slice(0, 6),
    others: ranked.filter((r) => r.score <= 0.15).slice(0, 30),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/selections/match-broadcast/route.ts
git commit -m "feat(api/selections): broadcast match candidates endpoint"
```

## Task 14: Kanban DnD + move actions

**Files:**

- Modify: `components/pipeline/KanbanBoard.tsx`
- Modify: `components/pipeline/SelectionCard.tsx`
- Create: `components/pipeline/BroadcastMatchDialog.tsx`
- Modify: `package.json`

- [ ] **Step 1: Install dnd-kit**

```bash
npm install @dnd-kit/core @dnd-kit/sortable
```

- [ ] **Step 2: Replace KanbanBoard with a DnD-enabled version**

Rewrite `components/pipeline/KanbanBoard.tsx` to use `DndContext` + droppable columns + draggable cards. The shape:

```tsx
"use client";
import { useState, useRef } from "react";
import {
  DndContext, DragEndEvent, useDroppable, useDraggable, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import type { BoardData, BoardCard, SelectionStatus } from "@/lib/selections/types";
import { SelectionCard } from "./SelectionCard";
import { BroadcastMatchDialog } from "./BroadcastMatchDialog";

const COLUMNS: Array<{ status: SelectionStatus; titleKey: string; tone: string }> = [
  { status: "selected",  titleKey: "selected",  tone: "bg-neutral-100 dark:bg-neutral-900/40" },
  { status: "sourcing",  titleKey: "sourcing",  tone: "bg-amber-100 dark:bg-amber-900/30" },
  { status: "scheduled", titleKey: "scheduled", tone: "bg-blue-100 dark:bg-blue-900/30" },
  { status: "closed",    titleKey: "closed",    tone: "bg-emerald-100 dark:bg-emerald-900/30" },
];

const LABELS: Record<SelectionStatus, string> = {
  selected: "선택됨", sourcing: "소싱중", scheduled: "방송예정", closed: "종료(최근 7일)",
};

const VALID: Record<SelectionStatus, SelectionStatus[]> = {
  selected:  ["sourcing", "closed"],
  sourcing:  ["selected", "scheduled", "closed"],
  scheduled: ["sourcing", "closed"],
  closed:    [],
};

function DropColumn({ status, children, count, tone }: {
  status: SelectionStatus; children: React.ReactNode; count: number; tone: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  return (
    <section
      ref={setNodeRef}
      className={`rounded-xl p-3 ${tone} ${isOver ? "ring-2 ring-indigo-400" : ""}`}
    >
      <header className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">{LABELS[status]}</h2>
        <span className="text-xs text-muted-foreground">{count}</span>
      </header>
      <div className="flex flex-col gap-2 min-h-[40px]">{children}</div>
    </section>
  );
}

function DragCard({ card, canWrite }: { card: BoardCard; canWrite: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id, disabled: !canWrite,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.5 : 1 }
    : undefined;
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <SelectionCard card={card} canWrite={canWrite} />
    </div>
  );
}

export function KanbanBoard({
  initialBoard, canWrite,
}: { initialBoard: BoardData; canWrite: boolean }) {
  const [board, setBoard] = useState(initialBoard);
  const [pendingMove, setPendingMove] = useState<{
    card: BoardCard; from: SelectionStatus; to: SelectionStatus;
  } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const previousBoard = useRef<BoardData>(initialBoard);

  async function performMove(card: BoardCard, to: SelectionStatus, extras: Record<string, unknown> = {}) {
    previousBoard.current = board;
    setBoard((b) => {
      const next: BoardData = { ...b };
      next[card.status] = b[card.status].filter((c) => c.id !== card.id);
      next[to] = [{ ...card, status: to }, ...b[to]];
      return next;
    });
    const res = await fetch(`/api/selections/${card.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_status: to, ...extras }),
    });
    if (!res.ok) {
      setBoard(previousBoard.current);
      const err = await res.json().catch(() => ({ error: "unknown" }));
      alert(`이동 실패: ${err.error}`);
    }
  }

  async function onDragEnd(e: DragEndEvent) {
    if (!e.over) return;
    const colId = String(e.over.id);
    if (!colId.startsWith("col:")) return;
    const to = colId.slice(4) as SelectionStatus;
    const card = (Object.values(board).flat() as BoardCard[]).find((c) => c.id === e.active.id);
    if (!card) return;
    if (card.status === to) return;
    if (!VALID[card.status].includes(to)) {
      alert(`${card.status} → ${to} 이동은 불가능합니다.`);
      return;
    }
    if (to === "scheduled") {
      setPendingMove({ card, from: card.status, to });
      return;
    }
    if (to === "closed") {
      const reason = window.prompt(
        "종료 사유? (aired / dropped / postponed)",
        "dropped",
      );
      if (!reason || !["aired", "dropped", "postponed"].includes(reason)) return;
      await performMove(card, to, { closed_reason: reason });
      return;
    }
    await performMove(card, to);
  }

  return (
    <>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {COLUMNS.map((col) => (
            <DropColumn key={col.status} status={col.status} count={board[col.status].length} tone={col.tone}>
              {board[col.status].map((c) => (
                <DragCard key={c.id} card={c} canWrite={canWrite} />
              ))}
              {board[col.status].length === 0 && (
                <p className="text-xs text-muted-foreground italic py-4 text-center">비어 있음</p>
              )}
            </DropColumn>
          ))}
        </div>
      </DndContext>
      {pendingMove && (
        <BroadcastMatchDialog
          card={pendingMove.card}
          onCancel={() => setPendingMove(null)}
          onConfirm={async (broadcastId, note) => {
            const card = pendingMove.card;
            setPendingMove(null);
            await performMove(card, "scheduled", { broadcast_id: broadcastId, scheduled_note: note });
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 3: Manual smoke**

Drag a card from `selected` to `sourcing`; the move should persist after refresh. Drag from `selected` to `scheduled` should open the dialog. Invalid transitions (e.g. dragging from `closed`) should be blocked client-side. Server-side 409 (stale) should revert the card.

- [ ] **Step 4: Commit**

```bash
git add components/pipeline/KanbanBoard.tsx components/pipeline/BroadcastMatchDialog.tsx package.json package-lock.json
git commit -m "feat(pipeline): DnD-enabled kanban with optimistic move"
```

## Task 15: Broadcast match dialog

**Files:**

- Create: `components/pipeline/BroadcastMatchDialog.tsx`

- [ ] **Step 1: Write the dialog**

Create `components/pipeline/BroadcastMatchDialog.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/selections/types";

type Suggestion = {
  id: string; channel: string; air_date: string; start_time: string | null;
  program_title: string; score: number;
};

export function BroadcastMatchDialog({
  card, onConfirm, onCancel,
}: {
  card: BoardCard;
  onConfirm: (broadcastId: string | null, note: string | null) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [channel, setChannel] = useState("all");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [others, setOthers] = useState<Suggestion[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchCandidates() {
      setLoading(true);
      const from = new Date().toISOString().slice(0, 10);
      const toDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const q = new URLSearchParams({
        productName: card.product.name,
        channel,
        from,
        to: toDate,
      });
      const res = await fetch(`/api/selections/match-broadcast?${q}`);
      if (!cancelled && res.ok) {
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
        setOthers(data.others ?? []);
      }
      setLoading(false);
    }
    fetchCandidates();
    return () => { cancelled = true; };
  }, [card.product.name, channel]);

  function handleConfirm() {
    if (manualMode) {
      if (!note.trim()) return;
      onConfirm(null, note.trim());
      return;
    }
    if (!picked) return;
    onConfirm(picked, null);
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <header className="p-4 border-b border-border">
          <h2 className="font-semibold">방송 슬롯 연결</h2>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{card.product.name}</p>
        </header>
        <div className="p-4 flex-1 overflow-auto">
          <label className="text-xs">채널</label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="w-full text-sm border border-border rounded px-2 py-1 mb-3"
          >
            <option value="all">전체</option>
            <option value="qvc">QVC</option>
            <option value="shopch">Shop Channel</option>
          </select>

          {!manualMode && (
            <>
              {loading && <p className="text-xs text-muted-foreground">검색 중…</p>}
              {!loading && suggestions.length > 0 && (
                <>
                  <p className="text-xs font-semibold mb-1">추천 후보</p>
                  {suggestions.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 p-2 border border-border rounded mb-1 cursor-pointer">
                      <input type="radio" name="bc" value={s.id}
                        checked={picked === s.id} onChange={() => setPicked(s.id)} />
                      <span className="text-xs">
                        <strong>{s.channel.toUpperCase()}</strong> · {s.air_date}
                        {s.start_time ? ` ${s.start_time}` : ""} · {s.program_title}
                      </span>
                    </label>
                  ))}
                </>
              )}
              {!loading && others.length > 0 && (
                <details className="mt-3">
                  <summary className="text-xs cursor-pointer">전체 결과 ({others.length})</summary>
                  {others.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 p-2 border border-border rounded mb-1 cursor-pointer">
                      <input type="radio" name="bc" value={s.id}
                        checked={picked === s.id} onChange={() => setPicked(s.id)} />
                      <span className="text-xs">
                        <strong>{s.channel.toUpperCase()}</strong> · {s.air_date}
                        {s.start_time ? ` ${s.start_time}` : ""} · {s.program_title}
                      </span>
                    </label>
                  ))}
                </details>
              )}
            </>
          )}

          <label className="flex items-center gap-2 mt-4 text-xs">
            <input type="checkbox" checked={manualMode} onChange={(e) => setManualMode(e.target.checked)} />
            broadcasts 테이블에 없는 슬롯 — 수동 입력
          </label>
          {manualMode && (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="채널, 일시, 메모 등을 자유롭게 입력하세요"
              rows={3}
              className="w-full mt-2 text-sm border border-border rounded px-2 py-1"
            />
          )}
        </div>
        <footer className="p-4 border-t border-border flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm border border-border rounded">
            취소
          </button>
          <button
            onClick={handleConfirm}
            disabled={manualMode ? !note.trim() : !picked}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded disabled:opacity-50"
          >
            확정
          </button>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Manual smoke**

Drag a card to `방송예정`. The dialog opens with the product's name pre-filled into the broadcast search. Picking a suggestion + confirm sets `broadcast_id` on the row. Toggling "수동 입력" + a note sets `scheduled_note`. Empty submits are disabled.

- [ ] **Step 3: Commit**

```bash
git add components/pipeline/BroadcastMatchDialog.tsx
git commit -m "feat(pipeline): broadcast-match dialog for scheduled transition"
```

## Task 16: Card menu + events timeline modal

**Files:**

- Create: `components/pipeline/CardMenu.tsx`
- Create: `components/pipeline/EventsTimelineModal.tsx`
- Modify: `components/pipeline/SelectionCard.tsx`

- [ ] **Step 1: Write the menu**

Create `components/pipeline/CardMenu.tsx`:

```tsx
"use client";
import { useState } from "react";
import { MoreVertical } from "lucide-react";
import type { BoardCard } from "@/lib/selections/types";
import { EventsTimelineModal } from "./EventsTimelineModal";

export function CardMenu({ card, onChanged }: { card: BoardCard; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  async function reopen() {
    setOpen(false);
    const res = await fetch(`/api/selections/${card.id}/reopen`, { method: "POST" });
    if (!res.ok) alert((await res.json()).error ?? "reopen failed");
    onChanged();
  }

  async function close() {
    setOpen(false);
    const reason = window.prompt("종료 사유? (aired / dropped / postponed)", "dropped");
    if (!reason || !["aired", "dropped", "postponed"].includes(reason)) return;
    const res = await fetch(`/api/selections/${card.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_status: "closed", closed_reason: reason }),
    });
    if (!res.ok) alert((await res.json()).error ?? "close failed");
    onChanged();
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="p-1 hover:bg-muted rounded"
      >
        <MoreVertical size={14} />
      </button>
      {open && (
        <div className="absolute right-2 top-8 bg-popover border border-border rounded shadow-lg text-xs z-10 w-40">
          <button onClick={() => setHistoryOpen(true)} className="block w-full text-left px-3 py-1.5 hover:bg-muted">
            이력 보기
          </button>
          <a
            href={card.product.product_url}
            target="_blank" rel="noreferrer"
            className="block w-full text-left px-3 py-1.5 hover:bg-muted"
          >
            원본 상품 보기
          </a>
          {card.status === "closed"
            ? <button onClick={reopen} className="block w-full text-left px-3 py-1.5 hover:bg-muted">다시 소싱으로</button>
            : <button onClick={close} className="block w-full text-left px-3 py-1.5 hover:bg-muted text-red-600">종료 처리</button>}
        </div>
      )}
      {historyOpen && (
        <EventsTimelineModal selectionId={card.id} onClose={() => setHistoryOpen(false)} />
      )}
    </>
  );
}
```

- [ ] **Step 2: Write the events modal**

Create `components/pipeline/EventsTimelineModal.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";

type EventRow = {
  id: string; event_type: string; from_status: string | null; to_status: string | null;
  closed_reason: string | null; note: string | null; is_system: boolean; created_at: string;
  actor: { display_name: string | null; email: string } | null;
};

export function EventsTimelineModal({
  selectionId, onClose,
}: { selectionId: string; onClose: () => void }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/selections/${selectionId}/events`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .finally(() => setLoading(false));
  }, [selectionId]);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl shadow-xl max-w-lg w-full max-h-[70vh] flex flex-col">
        <header className="p-4 border-b border-border flex justify-between">
          <h2 className="font-semibold">이력</h2>
          <button onClick={onClose} className="text-sm">닫기</button>
        </header>
        <ol className="p-4 overflow-auto text-xs space-y-2">
          {loading && <li className="text-muted-foreground">로딩 중…</li>}
          {!loading && events.map((e) => (
            <li key={e.id} className="border-l-2 border-border pl-3">
              <div className="text-muted-foreground">
                {new Date(e.created_at).toLocaleString()} ·{" "}
                {e.is_system ? "system" : (e.actor?.display_name ?? e.actor?.email ?? "?")}
              </div>
              <div>
                <strong>{e.event_type}</strong>
                {e.from_status && e.to_status && (
                  <span className="ml-1">({e.from_status} → {e.to_status})</span>
                )}
                {e.closed_reason && <span className="ml-1 text-red-600">[{e.closed_reason}]</span>}
              </div>
              {e.note && <div className="text-muted-foreground italic mt-0.5">{e.note}</div>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Integrate the menu into the card**

In `components/pipeline/SelectionCard.tsx`, import `CardMenu` and render it in the card header, top-right. Accept an `onChanged` callback prop that the menu fires after any successful mutation, so the board can re-fetch. Update `KanbanBoard.tsx` to refresh the board (re-fetch `/api/selections`) when a card reports a change.

```tsx
// In SelectionCard.tsx
import { CardMenu } from "./CardMenu";

// inside the article, top-right corner:
<div className="absolute top-2 right-2">
  {canWrite && <CardMenu card={card} onChanged={onChanged} />}
</div>
```

The `SelectionCard` props become `{ card; canWrite; onChanged }`. Update its `article` to be `relative`. Pass `onChanged` down from `KanbanBoard` — implement it as a refetch of `/api/selections` that updates the `board` state.

- [ ] **Step 4: Commit**

```bash
git add components/pipeline/CardMenu.tsx components/pipeline/EventsTimelineModal.tsx components/pipeline/SelectionCard.tsx components/pipeline/KanbanBoard.tsx
git commit -m "feat(pipeline): card [...] menu and events timeline modal"
```

## Task 17: Pipeline status chip on discovery + strategy cards

**Files:**

- Create: `components/pipeline/PipelineStatusChip.tsx`
- Modify: `components/discovery/ProductCard.tsx`
- Modify: `components/analytics/DiscoveredProductsHero.tsx`

- [ ] **Step 1: Write the chip**

Create `components/pipeline/PipelineStatusChip.tsx`:

```tsx
"use client";
import Link from "next/link";
import { ClipboardList } from "lucide-react";

type Stage = "selected" | "sourcing" | "scheduled" | "closed";

const LABEL: Record<Stage, string> = {
  selected: "선택됨", sourcing: "소싱중", scheduled: "방송예정", closed: "종료",
};

const TONE: Record<Stage, string> = {
  selected:  "bg-neutral-600/15 text-neutral-700 dark:text-neutral-300",
  sourcing:  "bg-amber-600/15 text-amber-700 dark:text-amber-300",
  scheduled: "bg-blue-600/15 text-blue-700 dark:text-blue-300",
  closed:    "bg-emerald-600/15 text-emerald-700 dark:text-emerald-300",
};

export function PipelineStatusChip({
  selectionId, stage,
}: { selectionId: string; stage: Stage }) {
  return (
    <Link
      href={`/analytics/pipeline?focus=${selectionId}`}
      className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${TONE[stage]}`}
    >
      <ClipboardList size={10} />
      <span>パイプライン: {LABEL[stage]}</span>
    </Link>
  );
}
```

- [ ] **Step 2: Surface the selection on each card**

The chip needs the active selection for a `discovered_product`. The simplest route: extend the discovery list / strategy list APIs to include `active_selection: { id, status } | null` joined from `product_selections`. For the discovery cards, that means amending whichever loader feeds `ProductCard` (likely `lib/discovery/cached.ts::getCachedDiscoveryToday`).

For each loader: add a left join to `product_selections` where `status != 'closed'` and surface `active_selection` to the client. Then in `ProductCard.tsx` and `DiscoveredProductsHero.tsx::ProductCard`, render:

```tsx
{p.active_selection && (
  <PipelineStatusChip selectionId={p.active_selection.id} stage={p.active_selection.status} />
)}
```

Place it next to existing source/pool badges in the card header.

For strategy: the strategy document already persists `discovered_product_id` per rec (Task 5). The strategy detail page can fetch active selections for the listed ids in a single `IN (...)` query at render time and pass `active_selection` into the card.

- [ ] **Step 3: Deep-link handling on /analytics/pipeline**

In `KanbanBoard.tsx`, read `?focus=<id>` from the URL via `useSearchParams`. When set, scroll to and highlight the matching card for 1.5 s after mount.

```tsx
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

const params = useSearchParams();
const focus = params.get("focus");

useEffect(() => {
  if (!focus) return;
  const el = document.querySelector<HTMLElement>(`[data-selection-id="${focus}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-2", "ring-indigo-400");
  const t = setTimeout(() => el.classList.remove("ring-2", "ring-indigo-400"), 1500);
  return () => clearTimeout(t);
}, [focus]);
```

Add `data-selection-id={card.id}` to the `article` in `SelectionCard.tsx`.

- [ ] **Step 4: Commit**

```bash
git add components/pipeline/PipelineStatusChip.tsx components/discovery/ProductCard.tsx components/analytics/DiscoveredProductsHero.tsx components/pipeline/KanbanBoard.tsx components/pipeline/SelectionCard.tsx lib/discovery/cached.ts
git commit -m "feat(pipeline): status chip on discovery+strategy cards with deep-link"
```

## Task 18: Cron — auto-advance aired scheduled selections

**Files:**

- Create: `app/api/cron/pipeline-auto-advance/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Write the handler**

Create `app/api/cron/pipeline-auto-advance/route.ts`:

```ts
import { NextResponse } from "next/server";
import { hasInternalSecret } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";

export const maxDuration = 60;

function todayJstISO(): string {
  // Convert UTC -> JST (UTC+9) and take the date part.
  const now = new Date();
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  if (!hasInternalSecret(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sb = getServiceClient();
  const today = todayJstISO();

  const { data: candidates, error: selErr } = await sb
    .from("product_selections")
    .select("id, broadcast_id, broadcast:broadcasts!inner(air_date)")
    .eq("status", "scheduled")
    .not("broadcast_id", "is", null)
    .lt("broadcast.air_date", today);

  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });

  let closed = 0;
  for (const row of candidates ?? []) {
    const airDate = (row as unknown as { broadcast: { air_date: string } }).broadcast.air_date;
    const { error: updErr } = await sb
      .from("product_selections")
      .update({
        status: "closed",
        closed_reason: "aired",
        closed_at: `${airDate}T12:00:00+09:00`,
        closed_by: null,
      })
      .eq("id", row.id)
      .eq("status", "scheduled");
    if (updErr) {
      console.warn("[cron/pipeline-auto-advance] update failed:", updErr.message);
      continue;
    }
    await sb.from("product_selection_events").insert([
      { selection_id: row.id, event_type: "status_changed", from_status: "scheduled", to_status: "closed", is_system: true },
      { selection_id: row.id, event_type: "closed", closed_reason: "aired", is_system: true, note: "auto-closed by cron after broadcast air_date" },
    ]);
    closed++;
  }

  invalidateSelectionsAfterMutation("cron-auto-advance");
  return NextResponse.json({ ok: true, closed });
}
```

- [ ] **Step 2: Register the cron and function in vercel.json**

Open `vercel.json`. Add under `functions`:

```json
"app/api/cron/pipeline-auto-advance/route.ts": { "maxDuration": 60 }
```

Add under `crons`:

```json
{ "path": "/api/cron/pipeline-auto-advance", "schedule": "0 18 * * *" }
```

(`0 18 * * *` UTC = JST 03:00.)

- [ ] **Step 3: Manual smoke**

Seed a `product_selections` row with status `scheduled` and a `broadcast_id` whose `air_date` is yesterday. Trigger the cron:

```bash
curl -X GET -H "Authorization: Bearer $CRON_SECRET" \
  https://<your-deployment>/api/cron/pipeline-auto-advance
```

Expected response: `{ "ok": true, "closed": 1 }`. Confirm the selection now has `status='closed'`, `closed_reason='aired'`, two new events with `is_system=true`.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/pipeline-auto-advance/route.ts vercel.json
git commit -m "feat(cron): daily auto-close scheduled selections whose broadcast aired"
```

## Task 19: Final smoke run

**Files:**

- (No new files; runs the full test suite the plan introduced.)

- [ ] **Step 1: Run all selection-related test scripts**

```bash
npm run test:selections
npm run test:strategy-fresh-search
```

Both should exit 0 with PASS lines.

- [ ] **Step 2: End-to-end manual checklist**

Walk through the manual checklist in `docs/superpowers/specs/2026-05-24-product-selection-pipeline-design.md` §12. Tick each item off as it passes:

- [ ] Sourced on `/discovery/home` → card appears in 선택됨.
- [ ] Sourced on `/strategy/expansion` (pool item) → card appears.
- [ ] Sourced on `/strategy/expansion` (fresh_search item, post-Task 5) → card appears.
- [ ] Drag to 방송예정 → dialog → broadcast pick → broadcast_id set.
- [ ] Drag to 방송예정 → dialog → manual note → scheduled_note set, broadcast_id null.
- [ ] Cron auto-close works on a yesterday-aired scheduled selection.
- [ ] Toggle sourced off (selected stage) → selection auto-closes with dropped.
- [ ] Toggle sourced off (sourcing stage) → selection preserved.
- [ ] Viewer account → board loads, no menu, no DnD; POST returns 403.
- [ ] Deep-link `?focus=<id>` scrolls + highlights.
- [ ] Nav badge count matches `SELECT COUNT(*) FROM product_selections WHERE status != 'closed'`.

- [ ] **Step 3: No commit — checklist only.**

---

## Self-Review (recorded after writing the plan)

- **Spec coverage**: every section of the design spec maps to at least one task. §6 schema → Task 1. §7 API → Tasks 7, 10–13. §8 cron → Task 18. §9 UI → Tasks 8, 14–17. §10 cache → Task 2 + Task 3 + invalidation inside each mutation handler. §11 integrity → enforced by Task 1 SQL + Task 11 optimistic lock + Task 10 toggle-off semantics. §12 testing → Tasks 4, 10, 19. §13 rollout order matches Task ordering.
- **Placeholder scan**: code blocks contain real code; SQL and TS are complete. Two soft spots: (a) `Navbar.tsx` integration in Task 9 Step 3 is shape-dependent on the existing Navbar (client vs. server component); the task documents both shapes and tells the implementer to follow whichever is already in use. (b) Task 17 Step 2 leans on amending the discovery loader to surface `active_selection`; the exact diff depends on the current loader shape but the join target and rendering surface are concrete.
- **Type consistency**: `SelectionStatus`, `BoardCard`, `BoardData` defined in Task 2 are referenced by every later task. `VALID_TRANSITIONS` in Task 11 matches the client copy in Task 14. Event types referenced everywhere are the same set defined in Task 1.
