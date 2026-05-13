# Adaptive Source-Mix Learning Design (Spec 3)

**Date:** 2026-05-13
**Status:** Exploratory draft — captures intent and known unknowns. Not actionable without further design work.
**Predecessor:** Spec 2 — source-mix ratio control (`2026-05-13-source-mix-ratio-control-design.md`)

## Problem

Spec 2 introduces a static target ratio for TXD vs fresh-discovery products (default 35%). That number is a guess. The user's expectation: as the system runs over time and collects feedback (sourced / interested / rejected) plus eventual sales outcomes, the ratio should *learn* its way to what works for this user's catalog.

Concretely:
- If most TXD items get rejected by the user but fresh-discovered items get sourced, the ratio should drift toward fresh.
- If a specific category (e.g., 美容・スキンケア) consistently shows the opposite — sourced TXD outperforms fresh — the per-category ratio should drift the other way.
- If a fresh-discovered product from a specific TV channel (e.g., ロッピングライフ) keeps converting to sales, that channel's items should be boosted.

This is a Bayesian-flavored multi-armed-bandit problem with several axes (TXD-vs-fresh, per-category, per-channel) and slow feedback (sales take weeks to materialize).

## Goals

1. Over a few months of operation, the global TXD ratio should self-adjust to the value that maximizes user-defined success (proxy: sourced-rate, or, when available, downstream sales).
2. Per-category ratios should emerge automatically — categories with strong TXD performance keep more TXD, categories with weak TXD shift toward fresh.
3. The system never *blocks* learning by being too aggressive — there's always exploration (occasionally trying ratios near the boundaries to keep learning).
4. The system never *forgets* — old feedback decays slowly so the model can adapt to changing user preferences without overweighting last-week's noise.

## Non-goals

- **Per-product personalization** ("user X likes brand Y"). This is a system-level mixing knob, not a recommendation engine.
- **Real-time learning** (within a single strategy run). Updates happen at the end of each strategy run or in a daily cron.
- **Replacing Gemini's product scoring.** Gemini still scores within each bucket; Spec 3 only adjusts the bucket sizes.
- **Cross-user learning.** Single-tenant for v1.

## Known unknowns (resolve during proper brainstorming)

1. **Success metric.** Three options, each with caveats:
   - **Source rate** (`user_action = "sourced" / total recommended`). Fast feedback (days). Risk: user clicks "source" before validating sales, so the rate may not predict actual revenue.
   - **Conversion to sales_weekly.** True signal but lags 4–8 weeks per item. Sparse — most strategies don't lead to direct measurable sales.
   - **Composite**: source rate × eventual sales lift. Best of both but requires sales attribution we don't currently have.
   
   Recommendation: start with source rate. Layer in sales data when attribution is built.

2. **Update cadence.**
   - **Per strategy run** (immediate). Every save updates the global ratio. Fast but noisy.
   - **Daily aggregate**. Cron consumes a day's strategies and feedback, updates the ratio. Smoother but slower.
   - **Weekly aggregate**. Even smoother. Probably right scale given sales lag.
   
   Recommendation: weekly. Build the daily one if needed later.

3. **Exploration / exploitation tradeoff.**
   - Pure greedy (always use the current learned ratio) → stops learning once the ratio settles.
   - ε-greedy (10% of strategies use a random ratio) → keeps exploring forever.
   - Thompson sampling (sample from a posterior distribution over the ratio) → principled Bayesian approach.
   
   Recommendation: ε-greedy with ε=0.15 for v1. Thompson sampling if v1 plateaus.

4. **Decay rate for old data.** Sales 6 months ago is less relevant than sales last week. Half-life options:
   - 30 days (fast adaptation, forgets old signal)
   - 90 days (balanced)
   - No decay (treats all data equally — bad if user preferences shift)
   
   Recommendation: 90-day half-life.

5. **Where does the state live?**
   - New table `source_mix_learning_state` with rows per (category, axis) and aggregate weights.
   - OR extend the existing `learning_state` table (used for discovery) with a new field.
   
   Recommendation: new table. Discovery's learning is about which keywords to seed; this is about how much TXD to use. Different domains, keep them apart.

6. **How to bootstrap.** New user has no feedback data. Options:
   - Use Spec 2's hardcoded default (35%) for the first N strategies, then start learning.
   - Use the average of similar users (privacy concern, none currently).
   - Random exploration for the first 10 strategies, then start exploiting.
   
   Recommendation: 35% default for first 10 strategies, then weight toward learned ratio with linear ramp over the next 10 strategies.

## Provisional architecture (sketch — fill in during proper brainstorming)

```
strategy run ──┐
               ├──→ source_mix_learning_state (DB)
feedback ──────┤
                   ↑
                   read in next strategy run → decides TXD ratio
```

**Tables:**

- `source_mix_learning_state`:
  ```
  id uuid pk
  scope text not null         -- 'global' | 'category:<name>' | 'channel:<slug>'
  txd_score numeric            -- accumulated outcomes for TXD bucket (decayed)
  fresh_score numeric          -- accumulated outcomes for fresh bucket (decayed)
  txd_trials int               -- count of recommendations made
  fresh_trials int             -- count of recommendations made
  last_updated_at timestamptz
  ```

- `source_mix_decisions`:
  ```
  id uuid pk
  strategy_id uuid fk md_strategies.id
  product_code text            -- TXD code or discovered_product_id
  bucket text                  -- 'txd' | 'fresh'
  category text                -- category at recommend time
  channel text                 -- for 'fresh' only, tv_channel_source
  outcome text                 -- 'pending' | 'sourced' | 'rejected' | 'interested' | 'duplicate'
  outcome_at timestamptz
  ```

**Updates:**

1. When a strategy is saved → insert `source_mix_decisions` rows (one per recommended product), bucket marked.
2. When feedback arrives → update the matching `source_mix_decisions.outcome`.
3. Weekly cron → aggregate `source_mix_decisions` by (scope, bucket) with 90-day exponential decay, write `txd_score` / `fresh_score` / `_trials` to `source_mix_learning_state`.
4. Next strategy run → read learning state, compute Beta posterior, sample ratio (Thompson) or use mean (greedy) with ε exploration.

## Provisional design steps (informal — will need brainstorming)

1. Decide success metric (source rate vs sales).
2. Decide update cadence (weekly).
3. Decide exploration policy (ε-greedy with ε=0.15).
4. Schema design (the two tables above).
5. Aggregation cron (weekly, computes decayed scores).
6. Read path (`md-strategy.ts` reads learning state, picks ratio).
7. Per-category and per-channel scopes (start with global, add others as data accumulates).
8. Verification: track learned ratio over time; expect convergence near the user's preferred mix within 4–8 weeks.

## Risks

- **Cold start.** First 10–20 strategies have no signal. Use the static default until enough trials accumulate.
- **Confounding.** Source rate confounds "AI picked a good product" with "ratio was right". A bad TXD pick will make TXD look worse, but maybe the ratio was fine and the *picking* was bad. Mitigation: track Gemini's confidence/score per pick so we can disentangle.
- **Reward hacking.** If we optimize for source rate, the system will learn to recommend products users *like to click source on* — which may not be the same as products that *sell*. This is why sales attribution matters eventually.
- **Sparse per-category data.** Some categories run once a quarter. Per-category ratios won't have enough trials to be meaningful for months.
- **Sales attribution is unbuilt.** Spec 3 leans on a signal we don't yet have. The first version using source-rate alone is fine, but full power requires attribution work.

## When to actually build this

Realistically — after Spec 2 has been live for **4–8 weeks** and we have enough feedback (`user_action`) data to assess whether the static 35% default is wrong, and in which direction. Without that data, designing the learning loop is guesswork on guesswork.

In the meantime, this document captures intent so Spec 2's `txd_fraction_metadata` is logged in a way that Spec 3 can later consume.

## Open follow-ups

- Need a proper brainstorming session to resolve the 6 known-unknowns above.
- Need a clear success metric agreed with the user before any code is written.
- Sales attribution mechanism is a prerequisite for the "good" version. Talk to the user about whether sales attribution is plausible in their data model.
