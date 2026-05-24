# Product Selection Pipeline — Design

**Date:** 2026-05-24
**Author:** brainstormed with Claude Opus 4.7
**Status:** Draft — pending user spec review

---

## 1. Context

The platform already produces product recommendations at two surfaces — `/[locale]/analytics/discovery/home` (TV + Web pool from `discovered_products`) and `/[locale]/analytics/strategy/expansion` (MD strategy recommendations sourced partly from the same pool, partly from on-the-fly Rakuten/Brave search). On the Discovery surface, each card carries a 4-button feedback affordance (`sourced` / `interested` / `rejected` / `duplicate`) that writes to `discovered_products.user_action` and to the `product_feedback` audit log.

What does **not** exist today:

- **Lifecycle tracking after selection.** Marking a candidate `sourced` is the strongest curatorial signal in the system — it is meant to communicate "I will sell this" — but the platform forgets about the decision after the toggle. There is no way to query "everything we have decided to sell and where in the funnel it sits", no link to a future broadcast slot, no record of what was aired vs. dropped.
- **Symmetric feedback across recommendation surfaces.** The strategy expansion page renders the same shape of card from the same `discovered_products` pool but does **not** render `FeedbackButtons` (`components/analytics/DiscoveredProductsHero.tsx::ProductCard`). A user who decides "I want this one" while reading a strategy cannot signal it from there.
- **Strategy fresh-search persistence.** Strategy recommendations come in three flavours via `pool_source`: `discovery_pool` / `seed` / `research` carry a `discovered_product_id`; `fresh_search` items are ephemeral Rakuten/Brave results that exist only inside the strategy document JSONB and have no `discovered_products` row to receive a feedback action.

This document specifies a two-phase change that (a) unifies feedback across both recommendation surfaces and (b) introduces a selection lifecycle (kanban) layered on top of the unified feedback signal.

## 2. Goals

- **G1** — Make `[✓ sourced]` available wherever a recommendation card appears (Discovery home + Strategy expansion + Live variants). Same component, same endpoint, same data model.
- **G2** — Persist strategy `fresh_search` recommendations into `discovered_products` at generation time so they participate in the same feedback system (no special-case feedback path).
- **G3** — Introduce `product_selections` as the canonical record of "we decided to sell this", with a 4-stage lifecycle (`selected → sourcing → scheduled → closed`), team ownership, broadcast-slot linkage, and an immutable event log.
- **G4** — Surface the pipeline at `/[locale]/analytics/pipeline` as a kanban board, reachable from the main `market` nav group with an active-count badge and from each sourced card via a deep-link chip.
- **G5** — Auto-advance `scheduled` selections that have a linked `broadcast_id` whose `air_date` is in the past, so the operator does not need to manually close every aired item.
- **G6** — Backfill existing `discovered_products.user_action = 'sourced'` rows whose original feedback author is recoverable, so day-zero of the new board is not empty.

## 3. Non-Goals

- No sales / revenue / units-sold / ROI tracking. The `closed` state captures only `aired | dropped | postponed`. Numerical outcomes belong to a future phase.
- No supplier / PO / cost-of-goods management. The `sourcing_note` text field is the only sourcing artifact in v1.
- No multi-broadcast linkage per selection. One selection links to at most one `broadcasts.id`. Re-airings are modelled as separate selections.
- No notifications / email / Slack triggers (assignee change, broadcast imminent, etc.). Out of scope.
- No restructuring of existing feedback semantics. `sourced / interested / rejected / duplicate` retain their current meaning. Only `sourced` opens a selection.
- No new auth roles. Existing `viewer / member / admin` is sufficient. Viewer is read-only on the board.
- No retroactive feedback for past strategy `fresh_search` recommendations. Persistence applies from the first deploy of Phase 0 forward; old strategy documents are not re-processed.

## 4. Current State — Key Findings (Cited)

### 4.1 Existing selection signal

- `discovered_products.user_action text CHECK (user_action IN ('sourced','interested','rejected','duplicate'))` plus `action_reason`, `action_at` is the team-shared current state of the operator's decision (`supabase/migrations/2026-04-18_discovery_system.sql`).
- `product_feedback (id, discovered_product_id, action, reason, user_id, created_at)` is the per-user audit log written alongside (verified at `app/api/discovery/feedback/route.ts:127-138`).
- The feedback toggle is implemented as: same-action-as-mine = toggle off (deletes my `product_feedback` row, recomputes team state from remaining rows); different-action-or-empty = upsert (`app/api/discovery/feedback/route.ts:77-138`).
- Cache invalidation hits five tags: `discovery:home_shopping`, `discovery:live_commerce`, `discovery:insights`, `discovery:history`, `discovery:selections` (`lib/discovery/cached.ts:364-370`).

### 4.2 Asymmetric feedback surface

- `components/discovery/ProductCard.tsx` imports and renders `FeedbackButtons` (line 9, 382-389).
- `components/analytics/DiscoveredProductsHero.tsx::ProductCard` (lines 29-383) does **not** import `FeedbackButtons`. Card actions are limited to "商品ページを確認" and a conditional "この商品を分析する". `pool_source` is rendered as a badge but there is no feedback affordance.
- The same `discovered_product_id` is available on most of these cards (always for `discovery_pool` / `seed` / `research`, never for `fresh_search`).

### 4.3 Strategy fresh-search ephemerality

- `lib/md-strategy.ts:407-455` defines `recommendedProducts` with optional `pool_source` and `discovered_product_id`.
- `pool_source === 'fresh_search'` recs (lines 831, 847, 868, 953) have `discovered_product_id === undefined` — they live only inside `md_strategies.product_selection` JSONB.

### 4.4 Discovery → Research link precedent

`supabase/migrations/2026-05-20_research_discovery_link.sql` adds `products.discovered_product_id uuid NULL REFERENCES discovered_products(id)` and `products.ingest_source text CHECK (ingest_source IN ('file_upload','discovery_promotion','manual_url'))`. The same pattern (one-way FK from a downstream table to `discovered_products`) is what `product_selections` will follow.

### 4.5 Broadcast slot tables

- `broadcasts (id, channel, air_date, start_time, program_title, ...)` is the canonical schedule for QVC + ShopCh + tracked OA channels (`lib/broadcasts/`).
- `broadcast_products` snapshots per-slot product detail; does not reference `discovered_products`.
- No existing FK from any other table to `broadcasts.id`. This design adds the first one (`product_selections.broadcast_id`).

### 4.6 Auth & navigation patterns

- `lib/auth/require-user.ts::requireUser([roles])` gates every API mutation (`app/api/discovery/feedback/route.ts:31`, `app/api/broadcasts/analyze-fit/route.ts`, etc.).
- `lib/nav/groups.ts` defines four groups; `market` group contains `broadcasts / discovery / strategy`. Adding a fourth member (`pipeline`) is the natural place.
- RLS pattern (Group A / Group B) is documented in `docs/superpowers/specs/2026-05-13-auth-and-tiered-access-design.md` and applied uniformly across recent migrations.

## 5. Architecture Overview

```
─────────────────────────────────────────────────────────────────────────
 Phase 0  Unify recommendation surfaces
─────────────────────────────────────────────────────────────────────────

  /discovery/home          ProductCard               [existing FeedbackButtons]
  /discovery/live          ProductCard               [existing FeedbackButtons]
  /strategy/expansion      DiscoveredProductsHero    [NEW FeedbackButtons]
  /strategy/live           (same card component)     [NEW FeedbackButtons]

  lib/md-strategy.ts (strategy generation):
    fresh_search / research recs → bulk insert into discovered_products
    (source='rakuten'|'brave'|'tv_channel', pool_source persisted, id assigned)
    md_strategies.product_selection jsonb gets discovered_product_id back

  /api/discovery/feedback also invalidates strategy list cache.

─────────────────────────────────────────────────────────────────────────
 Phase 1  Selection pipeline
─────────────────────────────────────────────────────────────────────────

  User clicks [✓ sourced] anywhere
       │
       ▼ single transaction (extends existing feedback handler)
  discovered_products.user_action = 'sourced'
  product_feedback row inserted (audit, per-user)
  product_selections row inserted (status='selected', owner_id=auth.uid())
  product_selection_events('created', actor_id=auth.uid())

       │
       ▼
  /[locale]/analytics/pipeline  ── 4-column kanban

   ┌───────────┐  ┌──────────┐  ┌────────────┐  ┌──────────┐
   │ selected  │→ │ sourcing │→ │ scheduled  │→ │ closed   │
   └───────────┘  └──────────┘  └─────┬──────┘  └──────────┘
                                       │
                            Moving to scheduled opens
                            broadcast-match dialog;
                            sets broadcast_id (FK) or
                            scheduled_note (free text).

       │
       ▼ daily JST 03:00 cron
  /api/cron/pipeline-auto-advance
    scheduled AND broadcast.air_date < today (JST)
      → closed, closed_reason='aired', is_system=true
```

## 6. Schema

### 6.1 `product_selections`

```sql
CREATE TABLE product_selections (
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

CREATE UNIQUE INDEX uniq_active_selection_per_product
  ON product_selections(discovered_product_id) WHERE status != 'closed';

CREATE INDEX idx_ps_status_active
  ON product_selections(status, updated_at DESC) WHERE status != 'closed';

CREATE INDEX idx_ps_owner_active
  ON product_selections(owner_id) WHERE status != 'closed';
CREATE INDEX idx_ps_assignee_active
  ON product_selections(assignee_id) WHERE status != 'closed';

CREATE INDEX idx_ps_discovered ON product_selections(discovered_product_id);
CREATE INDEX idx_ps_broadcast  ON product_selections(broadcast_id)
  WHERE broadcast_id IS NOT NULL;

CREATE TRIGGER trg_ps_updated_at BEFORE UPDATE ON product_selections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### 6.2 `product_selection_events`

```sql
CREATE TABLE product_selection_events (
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

CREATE INDEX idx_pse_selection_time
  ON product_selection_events(selection_id, created_at DESC);
```

Events are immutable — no UPDATE / DELETE policy is defined; both are denied by default.

### 6.3 RLS

```sql
ALTER TABLE product_selections        ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_selection_events  ENABLE ROW LEVEL SECURITY;

-- SELECT: any authenticated profile (viewer included)
CREATE POLICY ps_select  ON product_selections        FOR SELECT TO authenticated USING (true);
CREATE POLICY pse_select ON product_selection_events  FOR SELECT TO authenticated USING (true);

-- INSERT / UPDATE: member | admin only (viewer denied)
CREATE POLICY ps_write ON product_selections
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p
                 WHERE p.id = auth.uid() AND p.role IN ('member','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p
                      WHERE p.id = auth.uid() AND p.role IN ('member','admin')));

-- events: INSERT only, never UPDATE / DELETE
CREATE POLICY pse_insert ON product_selection_events
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p
                      WHERE p.id = auth.uid() AND p.role IN ('member','admin')));
```

API routes also call `requireUser(['member','admin'])` as the first gate; RLS is the last line of defence.

### 6.4 Backfill (same migration)

```sql
-- Existing sourced rows whose original author is recoverable
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
  );

INSERT INTO product_selection_events (
  selection_id, event_type, to_status, actor_id, is_system, note
)
SELECT id, 'created', 'selected', owner_id, true,
       'Backfilled from existing discovered_products.user_action=''sourced'''
FROM product_selections;
```

Sourced rows without a recoverable author are not backfilled; the next time the user re-toggles `sourced` they enter the board normally.

## 7. API Surface

All write endpoints gate with `requireUser(['member','admin'])`. Reads gate with `requireUser(['viewer','member','admin'])`.

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| GET  | `/api/selections`                       | `?status=&assignee=&q=&includeClosed=` | Board data (grouped by status) |
| GET  | `/api/selections/counts`                | —                                       | Active counts for nav badge |
| POST | `/api/selections/:id/move`              | `{ to_status, broadcast_id?, scheduled_note?, closed_reason?, closed_note? }` | Stage transition (optimistic lock via `WHERE id=? AND status=<from>`) |
| POST | `/api/selections/:id/assign`            | `{ assignee_id \| null }`               | Assign / unassign |
| PATCH| `/api/selections/:id/note`              | `{ field: 'sourcing_note'\|'scheduled_note'\|'closed_note', value }` | Inline note edit |
| POST | `/api/selections/:id/reopen`            | `{ note? }`                             | `closed → sourcing`, clears closed_* fields, writes `reopened` event |
| GET  | `/api/selections/:id/events`            | —                                       | Timeline |
| GET  | `/api/selections/match-broadcast`       | `?productName=&channel=&from=&to=`      | Broadcast candidate search, similarity-sorted |

### 7.1 Extension to `/api/discovery/feedback`

`POST /api/discovery/feedback` (`app/api/discovery/feedback/route.ts`) gets one additional behaviour, in the **same transaction** as existing writes:

- When the action being applied is `sourced` and the user is **adding** (not toggling off): insert a `product_selections` row with `status='selected'`, `owner_id = auth.uid()`, and a `product_selection_events('created', ...)` row.
- When the action `sourced` is being toggled **off** by the same user (existing toggle-off path): if there is an active selection (status != 'closed') that is still in `status='selected'` (operator has not advanced it), auto-close it with `closed_reason='dropped'`, `closed_at=now()`, `closed_by = auth.uid()`, `closed_note = 'sourced toggle removed'`, and emit `status_changed` + `closed` events. Selections that have already advanced past `selected` are left alone — the operator has invested work into them, and the toggle-off should not silently undo that.
- The endpoint must additionally call `invalidateSelectionsAfterMutation('feedback')` and (NEW) invalidate the strategy list cache tag.

### 7.2 Strategy fresh-search persistence (Phase 0)

`lib/md-strategy.ts`, immediately after Gemini curation completes and before `md_strategies.product_selection` is written:

- Collect recs where `discovered_product_id` is undefined and `pool_source in ('fresh_search','research')`.
- For each, derive a minimal `discovered_products` row: `name`, `name_normalized`, `source`, `product_url`, `price_jpy`, `category`, `context`, `tv_channel_source`, `seed_keyword='strategy:<strategyId>'`, `pool_source` (carried through if the column accommodates it; else stored in `seed_keyword` suffix).
- Bulk insert with conflict ignore against an existing dedup key. The dedup key used by the rest of Discovery is `(name_normalized, source)` within a recent window — Phase 0 will follow whichever pattern Discovery already uses. If no dedup index exists at the right shape, this design adds one as part of the same migration.
- After insert, write `discovered_product_id` back onto each rec so the strategy document JSONB persists it.

## 8. Cron — Auto-advance

`app/api/cron/pipeline-auto-advance/route.ts`:

- Schedule: JST 03:00 (UTC 18:00). Slot is free (existing crons at JST 01:00 broadcasts daily, 02:00 QVC monthly, 04:00 + 10:00 archive videos).
- Auth: `Bearer ${CRON_SECRET}` + `hasInternalSecret()`.
- Query: `product_selections ps JOIN broadcasts b ON ps.broadcast_id = b.id WHERE ps.status='scheduled' AND b.air_date < (today_jst)`.
- For each match: `UPDATE product_selections SET status='closed', closed_reason='aired', closed_at=b.air_date, ... WHERE id=? AND status='scheduled'` (defensive WHERE) and insert `status_changed` + `closed` events with `actor_id=NULL`, `is_system=true`.
- Calls `invalidateSelectionsAfterMutation('cron-auto-advance')` at the end.
- Scheduled selections **without** a `broadcast_id` (anchored by `scheduled_note` only) are not touched.
- `vercel.json` cron entry is added.

## 9. UI

### 9.1 Phase 0 — Card updates

**`components/analytics/DiscoveredProductsHero.tsx::ProductCard`:**
- Import `FeedbackButtons` from `components/discovery/FeedbackButtons.tsx`.
- Render after the metadata block, before the sales-strategy expansion. Use the same prop shape: `productId={p.discovered_product_id}`, `current={...}`.
- Render a `📋 파이프라인: <stage>` chip in the card header when there is an active selection (`status != 'closed'`). Click → `/analytics/pipeline?focus=<selection_id>`.
- When `discovered_product_id` is null (legacy strategy documents from before Phase 0 ships), `FeedbackButtons` is not rendered — the prop is required.

**`components/discovery/ProductCard.tsx`:**
- Add the same `📋 파이프라인: <stage>` chip; otherwise unchanged.

### 9.2 Phase 1 — `/[locale]/analytics/pipeline`

Page layout:

```
Header
  Active count: N (selected M / sourcing K / scheduled J)
  Closed (this week): X (aired Y / dropped Z)

Filter bar
  Scope: 전체 | 내 담당 | 내 선택
  Assignee: 전체 | <profile list>
  Search: q
  Include closed: ☐

Kanban (4 columns)
  selected | sourcing | scheduled | closed (this week)

  Card content per stage:
    selected:   thumb, name, price, TV-fit, owner, [···]
    sourcing:   + assignee, inline sourcing_note editor
    scheduled:  + broadcast slot ("QVC 5/28 20:00") or scheduled_note,
                "원본 슬롯 보기 →" link, assignee
    closed:     + closed_reason badge (aired/dropped/postponed),
                closed_at, optional archived video link if QVC

  [···] menu: 단계 변경 / 담당자 변경 / 종료 처리 / 이력 보기 / 원본 추천 보기
```

Interaction:
- Drag-and-drop via `@dnd-kit` (the standard accessible DnD library). Card `[···]` menu provides keyboard-accessible equivalents.
- Moving to `scheduled` opens the broadcast-match dialog; all other moves are immediate.
- Optimistic UI: card moves immediately, reverts on server error with a toast. Status transition uses `WHERE id=? AND status=<expected_from>` to detect concurrent moves.
- Mobile: at narrow widths, the 4 columns collapse into a vertical accordion (status sections).
- Deep-link `?focus=<selection_id>`: scrolls the matching card into view and applies a 1.5 s ring highlight.

### 9.3 Broadcast-match dialog

Opens only when moving to `scheduled`. Pre-fills the search with the product's `name`. Filters: channel, date range (default: next 30 days), keyword. Results pull from `broadcasts` and rank by name similarity + channel match. Below the result list, a "수동 입력" toggle reveals a textarea for `scheduled_note` — used when the operator knows of a slot the `broadcasts` table does not yet contain. On confirm: writes `broadcast_id` (if a candidate was picked) or leaves it NULL and sets `scheduled_note`; CHECK `scheduled_requires_anchor` ensures at least one is non-null.

### 9.4 Navigation

`lib/nav/groups.ts` — add to the `market` group's `members` array:

```ts
{ labelKey: 'nav.market.pipeline', href: '/analytics/pipeline' },
```

The pathPrefixes list gains `/analytics/pipeline`. A badge is rendered next to the label by reading `GET /api/selections/counts` (cached via `unstable_cache` tag `'selections:counts'`). Translation keys added to `messages/en.json` and `messages/ja.json`.

## 10. Cache Invalidation

```ts
// lib/selections/cached.ts (NEW)
export function invalidateSelectionsAfterMutation(source: string) {
  revalidateTag('selections:board');
  revalidateTag('selections:counts');
}
```

Callers:
- All `/api/selections/*` mutation endpoints.
- `/api/discovery/feedback` (when `sourced` opens or auto-closes a selection).
- `/api/cron/pipeline-auto-advance`.

Existing `invalidateDiscoveryAfterMutation` is extended (if not already) with the `discovery:selections` tag so the discovery cards' `📋 파이프라인: <stage>` chip refreshes after a stage change.

## 11. Integrity & Concurrency

| Invariant | Mechanism |
|---|---|
| ≤ 1 active selection per discovered product | partial unique index `uniq_active_selection_per_product` |
| `scheduled` requires a broadcast or a note | CHECK `scheduled_requires_anchor` |
| `closed` requires reason and timestamp | CHECK `closed_requires_reason` |
| Events are append-only | RLS: no UPDATE / DELETE policy defined |
| Viewer cannot mutate | RLS write policy + `requireUser(['member','admin'])` |
| Cron auto-close only touches valid candidates | `WHERE status='scheduled' AND broadcast_id IS NOT NULL AND b.air_date < today`; defensive WHERE on UPDATE |
| Concurrent stage moves | Optimistic lock: `UPDATE ... WHERE id=? AND status=<expected_from>`; client refreshes on miss |

## 12. Testing

The repo follows a `scripts/test-*.ts` + `npm run test:*` pattern (no Jest/Vitest). New scripts:

```
scripts/test-selections-state-machine.ts
  - Allowed transitions selected→sourcing→scheduled→closed; reopen closed→sourcing.
  - partial unique: two active selections on same discovered_product rejected.
  - scheduled without broadcast_id and without scheduled_note rejected.
  - closed without reason rejected.

scripts/test-selections-backfill.ts (dry-run)
  - For a small synthetic dataset: existing sourced rows with recoverable
    product_feedback authors get exactly one selection; rows without an
    author are skipped.

scripts/test-strategy-fresh-search-persist.ts
  - md-strategy generation with a fresh_search rec → discovered_products
    row exists with the expected (name_normalized, source) and pool_source;
    the strategy JSONB carries the discovered_product_id back.
```

Aliases in `package.json` under existing `test:*` siblings.

Pre-deploy manual checklist:
- [ ] `[✓ sourced]` on `/discovery/home` → board "선택됨" column shows the card immediately.
- [ ] Same on `/strategy/expansion` (Phase 0 active) for a pool-sourced rec.
- [ ] Same on `/strategy/expansion` for a `fresh_search` rec (persistence path active).
- [ ] Drag to "방송예정" opens the broadcast-match dialog; selecting a broadcast sets `broadcast_id`; "수동 입력" sets `scheduled_note` instead and rejects empty submits.
- [ ] `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/pipeline-auto-advance` closes a manually-crafted past-broadcast scheduled item.
- [ ] Toggle `sourced` off on a card whose selection is still in `selected`: selection auto-closes with `dropped`. Repeat with the selection advanced to `sourcing` — selection is preserved.
- [ ] Viewer account: `/analytics/pipeline` loads, all action buttons absent / disabled; direct POST to `/api/selections/:id/move` returns 403.
- [ ] Deep-link `/analytics/pipeline?focus=<id>` scrolls + highlights.
- [ ] Nav badge count matches `SELECT COUNT(*) FROM product_selections WHERE status != 'closed'`.

## 13. Rollout

1. **Migration** — `2026-05-24_product_selections.sql` (tables, indexes, RLS, backfill) applied.
2. **Phase 0 unification** —
   a. Strategy cache tag added to `/api/discovery/feedback`.
   b. `lib/md-strategy.ts` fresh-search persistence.
   c. `DiscoveredProductsHero.tsx` renders `FeedbackButtons`.
3. **Read-only board** — `GET /api/selections`, `/analytics/pipeline` page (no drag, no actions), nav entry + badge. Visible but inert; lets the team validate backfill + Phase 0 results.
4. **Activate selection writes** — extend `/api/discovery/feedback` to insert/auto-close selections.
5. **Write endpoints + interactions** — `/move`, `/assign`, `/reopen`, `/note`, broadcast-match dialog, DnD, `[···]` menu.
6. **Automation** — cron registration, `📋 파이프라인` chip on discovery/strategy cards.

Each step is independently revertable. Steps 1–3 are inert from the user's perspective (no behaviour change yet); only Step 4 starts the production data flow.

## 14. Risks & Open Items

**Risks to monitor:**

- **`discovered_products` row growth from `fresh_search` persistence.** Hourly/daily generation volume of strategies multiplies the table. Track the share of `pool_source='fresh_search'` rows over time; if dedup is insufficient, widen the dedup window or hash on `(name_normalized, source, source_url)`.
- **Timezone drift.** Cron close uses `broadcasts.air_date < today_jst`. If the broadcasts module ever switches to UTC dates, the cron must be updated in lockstep.
- **Backfill orphan rate.** If `product_feedback` lookup misses a meaningful percentage of existing sourced rows, the day-zero board will look thin. Mitigation: admin-account fallback owner. Decision deferred to implementation.
- **Optimistic UI vs. RLS rejection.** A viewer who hits the UI in a race could see a phantom move before the API refuses; the page must render action affordances strictly off the role check (not optimism).

**Open items (defer to implementation):**

- The exact dedup key for fresh-search persistence — whichever `discovered_products` already uses or a minimal new index on `(name_normalized, source)` if absent.
- Specific colour tokens for column headers and the closed-reason badges (`aired` / `dropped` / `postponed`). Phase-3-D style guide alignment to be confirmed.
- Whether `pool_source` on `discovered_products` should be promoted from `seed_keyword` suffix into its own column. Out of scope unless required for fresh-search persistence dedup; otherwise a Phase-2 follow-up.

**Explicit Phase 2+ follow-ups (not in this design):**

- Numerical outcomes after `closed.aired`: revenue, units, ROI input form on the closed card.
- Supplier / PO / cost-of-goods structured fields replacing the free-text `sourcing_note`.
- Multi-broadcast per selection (re-airings as N broadcasts under one selection rather than N selections).
- Notification triggers (assignee change, broadcast imminent).
- Insights dashboard (aired vs. dropped rate, category-level success).
