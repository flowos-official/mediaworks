# Selection Outcome Loop — feed real operator commitments (selected→aired) back into discovery learning + make tvFitScore falsifiable

- **Date**: 2026-05-29
- **Status**: Design (approved + adversarially verified against the codebase, pre-implementation)
- **Area**: Discovery learning (`lib/discovery/learning.ts`), product-selection pipeline (`product_selections`), admin observability
- **Related**:
  - System audit 2026-05-29 (P0-3 "closed loop ends at the 'sourced' click — aired is a write-only dead-end"; P0-4 "all scores unfalsifiable")
  - `docs/superpowers/specs/2026-05-24-product-selection-pipeline-design.md` (the 4-stage state machine this consumes)
  - `docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md` §5 (per-context learning_state)
- **Memory**: `[[project-discovery-optimizes-exposure-not-sales]]`, `[[feedback-discovery-prior-sales-soft]]`

## Problem

The discovery scoring stack predicts **exposure** (airing frequency + Rakuten rank + Gemini inference), never **realized commercial commitment**. The operator pipeline produces the strongest real signal the system can obtain — a product was `selected → sourcing → scheduled → aired` — but that signal dies in the audit log:

- `lib/discovery/learning.ts::computeContextLearning` consumes only `discovered_products.user_action` (`sourced`/`interested`) and `product_feedback.action='deep_dive'` clicks.
- `app/api/cron/pipeline-auto-advance/route.ts` writes `closed_reason='aired'` onto `product_selections`, but **no file in `lib/discovery` reads `product_selections`** (verified by grep: 0 references).
- `product_selections` (migration `2026-05-24_product_selections.sql`) has **no numeric outcome columns** — confirmed.

Consequently the learning loop cannot tell a product the operator merely *clicked* from one they *aired*, and there is **no measurement anywhere** of whether `tv_fit_score` predicts any downstream conversion (no backtest/calibration code exists, repo-wide).

The operator has confirmed (design intake): **only the binary fact "we selected it and it aired" is trustworthy** — no sales/units/revenue numbers are obtainable. So the signal is the pipeline progression itself, not a sales figure.

## Goal

1. **Close the loop**: every `product_selections` stage transition propagates a graded outcome onto the originating `discovered_products` row, and `computeContextLearning` folds those outcomes (weighted above a `deep_dive` click) into `category_weights`. Note the **scope of effect**: `category_weights` feeds only the keyword-planning *prompt emphasis* in `buildCategoryPlan` (a soft lever — see §3 and the C-2 risk below), not per-candidate `tvFitScore`. The end-to-end behavior change is therefore modest by design; the falsifiability win (Goal 2) is the stronger near-term deliverable.
2. **Make the score falsifiable**: a read-only calibration surface shows, per `tv_fit_score` band, the conversion rate to each pipeline stage — so a flat curve (high score ≠ higher conversion) becomes visible evidence the score is not predictive.

Both are achieved **without operator number entry** and **without changing per-candidate `tvFitScore`** (the audited score stack stays untouched).

## Non-goals

- Competitor sell-through proxy (P0-1/P0-2: `broadcast_products` re-polling, `txd SoldoutFlg`) — separate follow-up spec.
- Adding a realized-outcome **boost** to `tvFitScore` (audit Approach 2; rejected — would worsen the over-loaded score stack and amplify self-reinforcement).
- Any numeric/qualitative outcome **input UI** or external ERP integration.
- Changing the selection state machine, valid transitions, or RLS of `product_selections`.

## Signal model

| `product_selections` state | `selection_outcome` | rank | learning weight (default, env-tunable) |
|---|---|---|---|
| `selected` | `selected` | 1 | `+1` |
| `sourcing` | `sourcing` | 2 | `+2` |
| `scheduled` | `scheduled` | 3 | `+3` |
| `closed` + `closed_reason='aired'` | `aired` | 4 | `+5` |
| `closed` + `closed_reason='dropped'` (never advanced) | `dropped` | — | `-1` |
| `closed` + `closed_reason='postponed'` | *(no change)* | — | — |

`deep_dive` click contributes `+0.5` — a deliberate weak-click weight, below `selected` (`+1`), so a mere click ranks under an actual selection. (Correction: the pre-loop `categoryStats` loop added `+1` per `deep_dive`; the new graded scheme intentionally halves it — this is **not** "unchanged" behavior.) The graded funnel matters because `aired` is sparse and lagged; `sourcing`/`scheduled` are denser and arrive sooner, so the loop gets useful signal long before airings accumulate.

## Chosen approach (Approach 1): DB-trigger denormalization + plan-level learning + calibration view

A `SECURITY DEFINER` trigger on `product_selections.status` is the single source of write-back. Rejected alternatives:

- **Approach 2 — outcome→`tvFitScore` boost**: adds another magic-number boost to the stack the audit flagged; amplifies the "chase what already aired" bias. Rejected.
- **Approach 3 — no schema change, read-time JOIN in `learning.ts`**: avoids a migration but couples learning to the selection schema, makes the cohort/window logic awkward (airings lag discovery), and gives no cheap UI surface. Rejected.

Why a trigger over write-back in the handlers: the two write paths have **different auth contexts** — `/api/selections/[id]/move` runs as the member (`auth.sb`, RLS on), while `/api/cron/pipeline-auto-advance` runs as service role. Members already have UPDATE on `discovered_products` via the `member_all` policy (`2026-05-13_auth_rls_tight.sql`), so this is not about permission — it is about **uniformity and atomicity**: a `SECURITY DEFINER` trigger fires identically from the member path, the service-role path (feedback/cron), and the backfill, keeps the denormalization atomic with the status change, and leaves **all handler/cron code unchanged**.

## Components

### 1. Migration `supabase/migrations/2026-05-29_selection_outcome_signal.sql` (new)

**1a. Columns + index on `discovered_products`**
```sql
ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS selection_outcome text
    CHECK (selection_outcome IN ('selected','sourcing','scheduled','aired','dropped')),
  ADD COLUMN IF NOT EXISTS selection_outcome_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_dp_selection_outcome
  ON discovered_products (context, selection_outcome)
  WHERE selection_outcome IS NOT NULL;
```
Reads are covered by the existing `discovered_products` SELECT RLS — no new read policy.

**1b. Write-back trigger (single source of truth)**
```sql
CREATE OR REPLACE FUNCTION sync_selection_outcome() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cand text; cand_rank int; cur text; cur_rank int;
BEGIN
  IF    NEW.status = 'selected'  THEN cand := 'selected';
  ELSIF NEW.status = 'sourcing'  THEN cand := 'sourcing';
  ELSIF NEW.status = 'scheduled' THEN cand := 'scheduled';
  ELSIF NEW.status = 'closed' AND NEW.closed_reason = 'aired'   THEN cand := 'aired';
  ELSIF NEW.status = 'closed' AND NEW.closed_reason = 'dropped' THEN cand := 'dropped';
  ELSE  RETURN NEW;  -- postponed / unrecognized → leave outcome untouched
  END IF;

  SELECT selection_outcome INTO cur
    FROM discovered_products WHERE id = NEW.discovered_product_id FOR UPDATE;

  -- positive ladder; null & 'dropped' both rank 0 so any positive overrides them
  cur_rank := CASE cur WHEN 'selected' THEN 1 WHEN 'sourcing' THEN 2
                       WHEN 'scheduled' THEN 3 WHEN 'aired' THEN 4 ELSE 0 END;

  IF cand = 'dropped' THEN
    -- negative only sticks if the product never advanced past 'selected'
    IF cur IS NULL OR cur = 'selected' THEN
      UPDATE discovered_products
         SET selection_outcome = 'dropped', selection_outcome_at = now()
       WHERE id = NEW.discovered_product_id;
    END IF;
  ELSE
    cand_rank := CASE cand WHEN 'selected' THEN 1 WHEN 'sourcing' THEN 2
                          WHEN 'scheduled' THEN 3 WHEN 'aired' THEN 4 END;
    IF cand_rank > cur_rank THEN
      UPDATE discovered_products
         SET selection_outcome = cand, selection_outcome_at = now()
       WHERE id = NEW.discovered_product_id;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS product_selections_outcome_sync ON product_selections;
CREATE TRIGGER product_selections_outcome_sync
  AFTER INSERT OR UPDATE OF status ON product_selections
  FOR EACH ROW EXECUTE FUNCTION sync_selection_outcome();
```
**Monotonic on the positive ladder** (never regresses a positive outcome); `dropped` is recorded only when nothing positive beyond `selected` was reached, so an operator who invests effort (sourcing/scheduled) then drops still leaves a weak-positive trace. The partial-unique index `uniq_active_selection_per_product` permits **many closed selections + one active per product**, so the same `discovered_product_id` is the trigger target across re-selection lifecycles; because `cur_rank` treats `dropped` as rank 0, a fresh selection after a drop correctly upgrades the outcome again (covered by a dedicated test — see §5). `FOR UPDATE` serializes concurrent updates to the same product. The body is a single guarded UPDATE with no raise path, so it cannot roll back the selection transaction. There is no conflict with the existing `product_selections_updated_at_trg` (BEFORE UPDATE); this trigger is AFTER UPDATE OF status and does not fire on cascade DELETE.

**1c. Calibration view**
```sql
CREATE OR REPLACE VIEW discovery_score_calibration
  WITH (security_invoker = true) AS
SELECT
  context,
  width_bucket(tv_fit_score, ARRAY[40,60,75]) AS score_band,   -- 0:<40 1:40-59 2:60-74 3:>=75
  count(*)                                                          AS shown,
  count(*) FILTER (WHERE selection_outcome IN ('selected','sourcing','scheduled','aired')) AS selected_plus,
  count(*) FILTER (WHERE selection_outcome IN ('sourcing','scheduled','aired')) AS sourced_plus,
  count(*) FILTER (WHERE selection_outcome IN ('scheduled','aired')) AS scheduled_plus,
  count(*) FILTER (WHERE selection_outcome = 'aired')             AS aired,
  count(*) FILTER (WHERE selection_outcome = 'dropped')           AS dropped
FROM discovered_products
WHERE created_at >= now() - interval '90 days'
  AND tv_fit_score IS NOT NULL
  -- CRITICAL: exclude strategy fresh_search/research stub rows. They store
  -- tv_fit_score=0 with this exact sentinel reason (lib/strategy/fresh-search-persist.ts:100-101) —
  -- 0 is a non-null artifact of "not computed", not a real low prediction, and
  -- would pollute the <40 band and defeat the falsifiability goal.
  AND tv_fit_reason IS DISTINCT FROM 'Strategy fresh_search rec — score not computed'
GROUP BY context, score_band;
```
`security_invoker = true` makes the view honor the caller's `discovered_products` SELECT RLS (no privilege escalation; same pattern as `discovery_run_feedback_stats`, `2026-05-19_discovery_run_feedback_stats_view.sql`); the admin page gates display. **Rejected alternative** to the sentinel filter: writing `tv_fit_score: null` at `fresh-search-persist.ts:100` — `lib/strategy/pool-query.ts` orders by `tv_fit_score DESC`, and Postgres defaults to `NULLS FIRST` under `DESC`, which would float stubs to the top of the strategy pool. The view-side filter has zero blast radius and is preferred.

**1d. One-time backfill** — approximate furthest outcome from the *current* status of existing selections (the trigger is exact going forward; `product_selection_events` remains the precise history):
```sql
WITH ranked AS (
  SELECT discovered_product_id AS dpid,
         max(CASE WHEN status='closed' AND closed_reason='aired' THEN 4
                  WHEN status='scheduled' THEN 3 WHEN status='sourcing' THEN 2
                  WHEN status='selected'  THEN 1 ELSE 0 END) AS pos_rank,
         bool_or(status='closed' AND closed_reason='dropped')  AS any_dropped
  FROM product_selections GROUP BY discovered_product_id)
UPDATE discovered_products dp SET
  selection_outcome = CASE WHEN r.pos_rank=4 THEN 'aired' WHEN r.pos_rank=3 THEN 'scheduled'
                           WHEN r.pos_rank=2 THEN 'sourcing' WHEN r.pos_rank=1 THEN 'selected'
                           WHEN r.any_dropped THEN 'dropped' END,
  selection_outcome_at = now()
FROM ranked r WHERE dp.id = r.dpid AND (r.pos_rank > 0 OR r.any_dropped);
```

### 2. `lib/discovery/outcome-weight.ts` (new — pure, `tsx`-importable, no `import "server-only"`)

```ts
export type SelectionOutcome = 'selected'|'sourcing'|'scheduled'|'aired'|'dropped';

export const OUTCOME_WEIGHTS: Record<SelectionOutcome, number> = {
  aired:     Number(process.env.LEARNING_OUTCOME_W_AIRED     ?? 5),
  scheduled: Number(process.env.LEARNING_OUTCOME_W_SCHEDULED ?? 3),
  sourcing:  Number(process.env.LEARNING_OUTCOME_W_SOURCING  ?? 2),
  selected:  Number(process.env.LEARNING_OUTCOME_W_SELECTED  ?? 1),
  dropped:   Number(process.env.LEARNING_OUTCOME_W_DROPPED   ?? -1),
};
export function outcomeWeight(o: SelectionOutcome | null | undefined): number;

// Per-product success = max(outcome weight, user_action baseline). `interested`
// never creates a selection (only `sourced` does), so its click must still count
// — the user_action floor preserves it. `selection_outcome` takes precedence when
// present, so a product the operator backed out of (`dropped`, -1) is not rescued
// by a stale `sourced`. This is a max(), not a sum() → no double-count.
type UserAction = 'sourced' | 'interested' | 'rejected' | 'duplicate';
export function userActionWeight(a: UserAction | null | undefined): number; // sourced/interested→1, else 0

// Pure aggregation so it is unit-testable without a DB.
export interface CohortRow {
  category: string | null;
  selection_outcome: SelectionOutcome | null;
  user_action: UserAction | null;
}
export function aggregateCategoryWeights(
  cohort: CohortRow[],                 // discovered_products in cohort window
  deepDiveByCategory: Record<string, number>,
  opts?: { minSamples?: number; cap?: number },
): Record<string, number>;
// per product: rowSuccess = selection_outcome != null ? outcomeWeight(so) : userActionWeight(ua)
// success[cat] = Σ rowSuccess + 0.5 * deepDiveByCategory[cat]
// weight[cat]  = shown[cat] < minSamples ? 0.5 : clamp(success[cat] / shown[cat], 0, cap)
```

### 3. `lib/discovery/learning.ts` — `computeContextLearning` consumes outcomes

- Add one cohort query: `discovered_products` where `context = ctx` and `created_at >= now() - LEARNING_OUTCOME_COHORT_DAYS` (default **60**), selecting `category, selection_outcome, user_action`. The 60-day cohort (vs the existing 30-day window) absorbs the airing lag so `aired` rows are not systematically censored out. (Rows with `category IS NULL` are skipped as today — note this means strategy fresh_search stubs, which carry `category=null`, never enter category aggregation, so the BREAK in 1c does **not** affect learning.)
- Replace the current category success computation with `aggregateCategoryWeights(cohort, deepDiveByCategory)`, whose per-product rule is `selection_outcome ?? user_action` (max, not sum). This preserves the `interested` click signal — `interested` never creates a selection (only `sourced` does, per the pipeline design), so it has no `selection_outcome` and falls through to the `user_action` floor of `+1`. `sourced` becomes a `selected` selection (`+1`) and upgrades as it advances. `deep_dive` stays a separate `+0.5` click stream (Correction: this is **not** "current behavior" — the old loop used `+1`; the graded scheme intentionally halves it so a click ranks below `selected`=`+1`). Verified live: the feedback handler still writes `discovered_products.user_action` for every action including `interested`, so the floor is not vestigial.
- **Cold-start must NOT suppress `category_weights`.** Today `computeContextLearning` early-returns `category_weights={}` when `feedbackSampleSize < COLD_START_THRESHOLD` (10), and `feedbackSampleSize` is measured on the 30-day window — which can miss a 45-day-old `sourced` that only just `aired` (exactly the lagged signal this design targets, worst in low-volume contexts like `live_commerce`). Fix: compute and return `aggregateCategoryWeights` over the 60-day cohort **regardless** of the cold-start flag — either (a) move the category-weight block ahead of the early return and gate only `exploration_ratio`/`rejected_seeds` on cold-start, or (b) add the cohort's non-null-`selection_outcome` row count into `feedbackSampleSize` before the threshold test. `CATEGORY_MIN_SAMPLES` (5) still guards against a lone outcome dominating, so loosening the gate for weights is safe.
- `exploration_ratio`, `rejected_seeds`, `recent_rejection_reasons` stay on the existing 30-day window, unchanged.
- Failure of the new query degrades to the existing behavior (log + continue). The `catch` must explicitly tolerate Postgres `42703 undefined_column` (not just network errors) so that **if the migration is not yet applied, `daily-learning` degrades to the old behavior instead of throwing** the whole context's learning.
- Output flows only into `learning_state.category_weights` → `buildCategoryPlan`. Because `learning_state` is per-context and the cron loops both contexts, `live_commerce` plans get the outcome treatment automatically (a partial, plan-side easing of audit P1-2 — no live cron change here). **Strength caveat (C-2)**: `category_weights` is consumed only as a compressed top-10 textual hint in the keyword-planning Gemini prompt (`plan.ts`), competing with TV-proven/seasonal/rejection hints, and is ignored on the Gemini-failure fallback. A category moving 0.5→0.8 may not change the emitted keywords. To make the loop end-to-end verifiable, the plan work (see §5) adds an acceptance test asserting a category with a dominant aired-outcome cohort actually appears in the next plan; if stronger guarantees are wanted later, `buildCategoryPlan` can deterministically seed the top-weighted categories into `tv_proven` independent of the LLM (deferred, noted in Out of scope).

### 4. `app/[locale]/(admin)/admin/discovery-calibration/page.tsx` (new) + `/admin` index link

- Server component, `requireUser(['admin'])` with the `redirect(localePath(locale,'/login'))` pattern (Page components must redirect, not return `auth.error`). Mirrors `admin/archive-status/page.tsx`.
- Reads `discovery_score_calibration` via `getServerClient()` (RLS-respecting; `security_invoker` view + admin gate). Renders one table per `context`: score band → `shown`, and `selected+ / sourced+ / scheduled+ / aired` as counts **and** % of `shown`, plus `dropped`.
- **Display guards (D-4)**: grey out / suppress the conversion **%** for any band where `selected_plus < 5` (mirrors `CATEGORY_MIN_SAMPLES`) and always show raw counts alongside; render a caption that `aired` lags discovery by weeks–months (the 90-day window under-counts recent `aired`), so a near-zero `aired` is not misread as the score being non-predictive.
- Add a card/link on `app/[locale]/(admin)/admin/page.tsx`. No nav change (admin-only).

### 5. Tests + `package.json` + migration gate

- `scripts/test-selection-outcome-trigger.ts` → `npm run test:selection-outcome` (live DB; needs a `profiles` row, like `test:selections`): create `discovery_runs` + `discovered_products` + `product_selections`; drive `selected→sourcing→scheduled→closed(aired)` and assert `selection_outcome` is monotonic and ends `aired`; assert `selected→closed(dropped)` ⇒ `dropped`, and `scheduled→closed(dropped)` preserves `scheduled`. **dropped→resurrect case (A-1)**: close selection A as `dropped` (assert `dropped`), then create a NEW selection B on the **same** `discovered_product_id` (allowed once A is closed) and advance `selected→sourcing` — assert the outcome upgrades to `sourcing`, proving `dropped` is rank 0. Clean up rows.
- `scripts/test-learning-outcome-weighting.ts` → `npm run test:learning-outcome-weighting` (pure, no env): unit-test `outcomeWeight`, `userActionWeight`, and `aggregateCategoryWeights` (weighting, `selection_outcome ?? user_action` precedence, min-samples fallback to 0.5, clamp, `dropped` pulling a category negative).
- Calibration view shape smoke (select from view, assert columns + that a seeded stub row is excluded) folded into the trigger script.
- **Migration gate (E-1)**: add `selection_outcome` and `selection_outcome_at` to `REQUIRED_COLUMNS.discovered_products` in `scripts/check-migrations.ts` so `npm run test:migrations` fails until the migration is applied (the repo has no auto-apply runner — `check-migrations.ts` only probes columns). The implementation plan must include an explicit apply step (Supabase Studio SQL editor or `supabase db push`) **before** shipping the `learning.ts` read.

## Data flow

```
operator drag / feedback toggle / pipeline-auto-advance cron
  → UPDATE product_selections.status                    (existing code, unchanged)
  → ★ trigger sync_selection_outcome (SECURITY DEFINER)            ← NEW
  → discovered_products.selection_outcome (monotonic, denormalized) ← NEW
        │
        ├─ daily-learning cron (22:45 JST) → computeContextLearning
        │     → aggregateCategoryWeights (60-day cohort, weighted)  ← NEW
        │     → learning_state.category_weights → buildCategoryPlan (next-day search, soft hint)
        │
        └─ discovery_score_calibration view → /admin/discovery-calibration (read-only)  ← NEW
```

## Edge cases & risks

- **Right-censoring**: a product discovered yesterday cannot have aired. Mitigated by the 60-day cohort + the graded funnel (sourcing/scheduled fill the gap). The calibration view uses a 90-day window for the same reason; recent bands under-count `aired` — surfaced via the page caption.
- **`shown` denominator (D-2)**: `count(*)` counts `discovered_products` rows, and cross-session dedup (`2026-04-19_discovered_products_cross_session_dedup.sql`) does not prevent the same `product_url` appearing as multiple rows across sessions, while `selection_outcome` lands on only one of them — so conversion% can be slightly deflated. This **mirrors the existing learning `shown` query's convention**, so it introduces no new inconsistency; documented so the admin page does not over-interpret absolute %. A `count(DISTINCT product_url)` refinement is deferred to v2.
- **Sparse `aired`**: `CATEGORY_MIN_SAMPLES` (5) keeps a single airing from defining a category weight; the page suppresses % for thin bands.
- **Self-reinforcement** (audit central risk): bounded — outcomes touch only the plan (a soft prompt hint), never `tvFitScore`; `dropped` is a corrective down-weight on categories the operator keeps rejecting despite competitor-hotness; the calibration view is the watchdog (flat curve ⇒ the loop is chasing its tail).
- **Trigger safety**: single guarded UPDATE, `postponed` is a no-op, no raise path ⇒ never aborts a legitimate selection move; `FOR UPDATE` prevents concurrent-update races on one product; no conflict with the existing BEFORE-UPDATE timestamp trigger; does not fire on cascade DELETE.
- **Backfill approximation**: derives from current selection status, so a selection that reached `scheduled` then closed `postponed` backfills as no-positive. Rare; the forward trigger is exact and `product_selection_events` keeps the true history.

## Decisions (resolved at design intake)

1. Weights `aired=5 / scheduled=3 / sourcing=2 / selected=1 / dropped=-1`, all env-overridable.
2. Category-weight cohort window = **60 days** (`LEARNING_OUTCOME_COHORT_DAYS`); exploration-ratio logic stays at 30.
3. `dropped` used as a **negative** signal.
4. Calibration surface = new **`/admin/discovery-calibration`** page (consistent with `/admin/historical-crawl`, `/admin/archive-status`).

## Verification (2026-05-29 adversarial review, 5 dimensions vs codebase)

Verdict: **minor-fixes, no rework**. Confirmed sound: trigger fires on all 6 status-write paths with `status`+`closed_reason` set in a single UPDATE (so `NEW.closed_reason` is readable); `discovered_products` is RLS-enabled but not `FORCE`, so the migration-owner `SECURITY DEFINER` function bypasses RLS; `security_invoker` views and `width_bucket` are available; `discovered_products.context` is `NOT NULL DEFAULT`; the feedback handler still writes `user_action`. One BREAK (stub pollution of the calibration view) and the medium risks (cold-start suppression, soft plan lever, missing-migration gate, dropped→resurrect test coverage, denominator/sparsity display) are all folded into the sections above.

## Out of scope (recommended as separate specs)

- Competitor sell-through proxy: `broadcast_products.in_stock_at_capture` re-polling cron + persisting `txd SoldoutFlg` (audit P0-1/P0-2).
- Realized-outcome influence on per-candidate `tvFitScore` — only after the calibration view demonstrates the current score is mis-calibrated and quantifies the needed correction.
- Deterministic top-weighted-category seeding into `buildCategoryPlan` (strengthen the C-2 lever beyond a prompt hint).
- Home-path competitor-boost aggregate clamp + penalty ordering (audit P1-1); live-cron fit-weighting parity (P1-2 score side).
