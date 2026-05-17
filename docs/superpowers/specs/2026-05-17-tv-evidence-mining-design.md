# TV Evidence Mining — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-05-17
**Scope**: Feature A of the broadcast-data → AI integration roadmap. Sequel features (C: Pricing Intelligence, B: Time-Slot Predictor) are tracked separately and built only after this one ships.

---

## 1. Goal

For every newly discovered candidate in `discovered_products`, attach a deterministic JSON record (`tv_evidence`) describing **how similar products have actually been televised in Japan** based on the broadcast data we already store. The same record powers three downstream surfaces:

1. **Scoring** — additive bonus on `tv_fit_score`, capped within the existing 40% historical-data ceiling, so winners with real on-air history rise without overpowering the score.
2. **Report grounding** — the synthesize pipeline prepends a `実測データ:` block to the Gemini prompt for the Competitor / Seasonality / PricingStrategy / BroadcastScript sections, replacing speculative narratives with measured ones.
3. **Discovery UI** — a small evidence badge on each candidate card (e.g. "QVC 89回 · ShopCh 41回 · 30日内 18回 · 中央値 ¥6,800").

No Gemini call is made inside the evidence computation itself — it is rule-based, deterministic, and cheap (target: <100ms per candidate on cold cache).

## 2. Non-Goals

These are explicit YAGNI carve-outs:

- ML-based channel-fit classifier (insufficient labeled data — category accuracy only stabilized this week; revisit in ~6 months).
- Broadcast description corpus mining for script generation (separate future spec).
- Standalone trend dashboard UI (separate future spec).
- Pricing narrative synthesis — that is Feature C, which consumes `tv_evidence.price_jpy` but adds Gemini reasoning on top.
- Time-slot recommendation per channel — that is Feature B; this spec only surfaces the raw `top_timeslots` array.
- Per-channel ML scoring; here we only emit aggregate counts and a single scalar `evidence_strength`.
- `pg_trgm` extension install — name matching uses existing `lower()` btree index; trigram is a future optimization if recall is too low.

## 3. Data Sources

| Table | Fields used | Notes |
|---|---|---|
| `broadcasts` | `channel`, `air_date`, `start_time`, `category`, `product_ids`, `description` | shopch + qvc. Time available. Category whitelist already enforced upstream. |
| `historical_broadcasts` | `channel`, `air_date`, `category`, `product_name`, `price_jpy` | 8 OA channels. Date-only. Provides the only 5-year price signal. |
| `qvc_products` | `name`, `price_text`, `category` | Joined to `broadcasts` via `product_ids[]` when QVC slot has the link. Used to enrich QVC samples with concrete prices when `historical_broadcasts` has none. |
| `discovered_products` | `category`, `price_jpy`, `name`, `name_normalized` | The candidate being enriched. |

Read access is via `getServiceClient()` because evidence enrichment is called from cron and orchestrator paths that are non-user-initiated. RLS bypass is intentional and matches the existing `recent-broadcast-penalty.ts` pattern.

## 4. Matching Strategy

Three independent matching axes are computed and combined. Each axis is a SQL query against the broadcast tables, returning matched broadcast rows.

| Axis | Predicate | Fallback |
|---|---|---|
| **Category fuzzy** | candidate.category mapped through `CATEGORY_MAPPING` from `lib/strategy/pool-query.ts`, then `=` against broadcast `category` | If candidate has no category, this axis returns ∅ |
| **Price band** | `price_jpy BETWEEN candidate.price × 0.75 AND candidate.price × 1.25` | If candidate has no price, skip this axis; cap `evidence_strength` at 0.5 |
| **Name fuzzy** | Tokenize candidate.name on whitespace/punctuation, keep tokens ≥ 3 chars, run `lower(product_name) LIKE '%token%'` on `historical_broadcasts` (uses existing `historical_broadcasts_product_lower_idx`). Limit to 3 most distinctive tokens. | If 0 tokens qualify, this axis returns ∅ |

A broadcast row is included in the aggregate if it matches **(category) AND (price OR name)**. Category alone is the floor — we never aggregate unrelated categories — but we accept either price-band or name-token corroboration.

`evidence_strength` is computed as:

```
base = clamp01(log10(1 + airing_count) / 2.5)         // 0 at 0 hits, ~1 at 300+ hits
recency = clamp01(recent_30d_count / 10)              // 1 at 10+ in last 30d
diversity = clamp01(distinct_channels / 4)            // 1 at 4+ channels
strength = 0.5*base + 0.3*recency + 0.2*diversity
strength *= price_completeness                        // 0.5 if price axis was skipped, else 1.0
```

Concrete weight values may shift during implementation; the **shape** (additive, bounded, recency-weighted) is the contract.

## 5. Evidence JSON Shape

Stored on `discovered_products.tv_evidence` (jsonb). Null when no category match. Schema:

```jsonc
{
  "matched_at": "2026-05-17T10:00:00Z",
  "match_basis": {
    "category": "ビューティー",
    "price_band": [3000, 8000],            // null if price axis skipped
    "name_tokens": ["セラム", "美容液"]      // [] if name axis skipped
  },
  "airing_count": 142,                     // total matched rows across all sources
  "recent_30d_count": 18,
  "recent_90d_count": 47,
  "channel_breakdown": {                   // counts per channel slug
    "qvc": 89, "shopch": 41, "japanet": 12
  },
  "price_jpy": {                           // null if no historical price hits
    "median": 6800, "p25": 4500, "p75": 12500, "count": 89
  },
  "top_timeslots": [                       // shopch+qvc only; up to 5 rows
    { "channel": "qvc", "dow": "tue", "hour_bucket": 14, "count": 12 }
  ],
  "samples": [                             // up to 5, ordered by recency
    { "channel": "qvc", "air_date": "2026-05-15",
      "title": "...", "price_jpy": 7800 }
  ],
  "evidence_strength": 0.78                // 0..1
}
```

A companion timestamp `tv_evidence_at timestamptz` records when the row was last computed. The cron job uses this to find stale rows.

## 6. Architecture & Module Layout

```
Discovery flow
  orchestrator.ts (stage 1: search)
    → orchestrator.ts (stage 2: enrich)
        → tv-evidence.ts::computeTvEvidence(candidate)
            ├─ 3 SQL queries (parallel) → broadcast rows
            ├─ aggregate to TvEvidence shape
            └─ return null on 0-category-match (fail-open)
        → scoring step adds evidence_bonus to tv_fit_score

Cron refresh
  GET /api/cron/refresh-tv-evidence       (weekly, Vercel cron)
    → finds discovered_products where tv_evidence_at is null
      OR older than 7 days
    → re-runs computeTvEvidence in batches of 50

Report synthesize
  /api/analyze/synthesize
    → if linked discovered_product has tv_evidence,
      prepend `実測データ:` block to Gemini prompt for the
      Competitor/Seasonality/PricingStrategy/BroadcastScript sections

Discovery UI
  components/discovery/TvEvidenceBadge.tsx (member+/admin only)
    → fetches GET /api/discovery/[id]/tv-evidence
    → renders compact badge in candidate card
```

### File inventory

| Layer | Path | Notes |
|---|---|---|
| Migration | `supabase/migrations/2026-05-17_tv_evidence.sql` | Adds `tv_evidence jsonb`, `tv_evidence_at timestamptz`, GIN index on `tv_evidence` |
| Compute | `lib/discovery/tv-evidence.ts` | Exports `computeTvEvidence`, `applyEvidenceBonus`, `__test` hooks |
| Types | `lib/discovery/types.ts` (extend) | Add `TvEvidence` interface |
| Pipeline hook | `lib/discovery/orchestrator.ts` | Insert evidence step in stage 2 enrich loop |
| Score hook | Wherever `tv_fit_score` is finalized (likely `lib/discovery/scoring.ts`; confirm at plan time) | Add `+ evidence_bonus` term, document interaction with 40% historical cap |
| Cron | `app/api/cron/refresh-tv-evidence/route.ts` | `Bearer ${CRON_SECRET}`, `hasInternalSecret()` |
| Cron schedule | `vercel.json` | Weekly, Sunday 17:00 UTC (Monday 02:00 JST, after the daily broadcast scrape settles) |
| API | `app/api/discovery/[id]/tv-evidence/route.ts` | `requireUser(['member','admin'])` — viewer gets 403 |
| UI | `components/discovery/TvEvidenceBadge.tsx` | Small badge, member+ only |
| Report grounding | Synthesize prompt builder (path confirmed at plan time) | Prepend `実測データ:` block when present |
| Test fixtures | `tests/discovery/fixtures/tv-evidence/*` | Sample broadcast rows + expected JSON |
| Tests | `tests/discovery/tv-evidence.test.ts` | Unit + DB integration. Alias: `npm run test:tv-evidence` |

## 7. Score Integration

```
final_tv_fit_score =
  base_tv_fit_score
  + evidence_bonus                         // 0..15, derived from evidence_strength
  − recent_broadcast_penalty               // existing soft penalty, unchanged
  ⌊ 40% historical-data cap                // existing global ceiling, unchanged
```

- `evidence_bonus = round(evidence_strength * 15)` — capped at +15, never negative.
- Recent broadcast penalty (`recent-broadcast-penalty.ts`) is applied **after** evidence bonus, so a product just aired on QVC can still net below an evidence-rich exploration candidate. This preserves the [[feedback-discovery-prior-sales-soft]] principle that recent on-air status is a *de-prioritization*, never an exclusion.
- The 40% historical-data weight ceiling (commit `2dcaed9`) wraps the entire historical contribution: evidence bonus + any other historical-based term. If implementation finds the cap conflicts with this bonus, the cap wins and the bonus is scaled down proportionally.

## 8. Report Integration

When a report pipeline synthesizes a research report and the source product can be linked to a `discovered_products` row (by `product_url`, `rakuten_item_code`, or normalized name — exact lookup chosen at plan time), the synthesize prompt receives an additional block in Japanese. The two known entry points are `/api/analyze/synthesize` (file-upload research) and the strategy pipeline (`/api/analytics/md-strategy`) which already carries `discovered_product_id` per recommendation. The strategy path is the easier first integration; the analyze path lands once a name/URL matcher is wired up.

```
【実測データ】このカテゴリの類似商品の日本ホームショッピング放送実績:
- 総放送回数: 142回 (直近30日: 18回, 90日: 47回)
- チャンネル別: QVC 89回 / ShopCh 41回 / Japanet 12回
- 価格帯 (中央値): ¥6,800 (¥4,500〜¥12,500)
- 主な時間帯: QVC 火 14:00 (12回), ShopCh 土 20:00 (9回)
- 代表サンプル: ... (最大5件)
```

The prompt instructs Gemini to ground Competitor / PricingStrategy / Seasonality / BroadcastScript sections in this data rather than estimating. If `tv_evidence` is null, the prompt is unchanged (backward-compatible).

The Competitor UI component (`components/report/CompetitorSection.tsx`) gains an optional "実測放送データ" subsection that renders the evidence directly (no AI), so users see raw numbers alongside Gemini's narrative.

## 9. Failure Modes & Fail-Open Policy

| Scenario | Behavior |
|---|---|
| Candidate has no category | Skip evidence entirely. `tv_evidence = null`. No score change. |
| Category match returns 0 rows | `tv_evidence = null`. No score change. |
| Candidate has no price | Run category + name axes only. Cap `evidence_strength` at 0.5. |
| DB error during compute | Log warning, return null. Score unchanged. (Matches `recent-broadcast-penalty.ts` policy.) |
| Cron refresh fails for one row | Log per-row, continue batch. Job overall succeeds if ≥90% of rows succeed. |
| Gemini synthesize call (downstream) | Unrelated — evidence is just a prompt input. Existing synthesize error handling applies. |

## 10. Security & RLS

- `tv_evidence` is **Group B** (member/admin only). Viewers see candidate cards without the evidence badge and never get the JSON via API.
- Postgres column RLS is inherited from the table, so adding columns to `discovered_products` does not require new policies. The migration verifies existing `discovered_products` policies already cover member/admin read + viewer denial; if not, that's a pre-existing bug to fix in this migration, not new evidence-specific policy work. Service role retains bypass for cron paths.
- Cron endpoint authenticates via `Bearer ${CRON_SECRET}` and `hasInternalSecret()`, identical to existing daily-broadcasts cron.
- API endpoint uses `requireUser(['member','admin'])` from `lib/auth/require-user.ts`.

## 11. Performance Targets

- Single-candidate compute: <100ms p95 on warm DB cache (3 SQL queries, all hitting existing indexes).
- Cron batch (full table refresh ~10k rows): <10 minutes, well within the 300s synthesize-class function timeout once batched at 50 rows × 200 batches = ~6 minutes wall-clock with parallel queries inside each batch.
- No new external API calls. No new Gemini calls.

## 12. Test Plan

**Unit (no DB):**
- `aggregateBroadcastRows(rows)` produces correct counts, percentiles, and timeslot top-N from a fixture array.
- `computeEvidenceStrength({airing_count, recent_30d_count, distinct_channels, price_completeness})` yields expected values at boundary cases (0 hits, single channel, full-strength).
- `tokenizeName(name)` keeps tokens ≥3 chars, limits to 3.

**Integration (real Supabase, gated by `SUPABASE_SERVICE_ROLE_KEY`):**
- Seed `broadcasts` and `historical_broadcasts` with a known fixture set.
- Run `computeTvEvidence` against a synthetic candidate.
- Assert the resulting JSON matches the expected snapshot.
- Verify score bonus integration through the orchestrator's stage 2 with a single candidate.

**npm scripts:**
- `npm run test:tv-evidence` — runs unit + integration suite.
- Live diagnostic: `tsx scripts/check-tv-evidence.ts <discovered_id>` — prints evidence for a single existing candidate to verify against intuition.

## 13. Migration / Rollout

1. Apply migration (`tv_evidence`, `tv_evidence_at`, GIN index, RLS update if needed).
2. Deploy compute module + orchestrator hook + cron + API + UI badge in one PR (single worktree).
3. First cron run populates evidence for the existing backlog (~10k rows) over <10min.
4. New discoveries get evidence inline at stage 2 from deploy onward.
5. Report grounding is feature-flagged off in the same PR; flip it on after spot-checking 5–10 candidates' evidence JSON looks reasonable.

Rollback: drop the column reads from orchestrator/scoring/synthesize, leave the column in place (no data loss). Migration is forward-only; the column is nullable and additive.

## 14. Open Questions Resolved by This Spec

- **Q**: Where exactly does the score bonus get added? **A**: Documented at plan-writing time — the exact file is whichever module currently produces final `tv_fit_score`. Identified during implementation, not blocking design.
- **Q**: How does this interact with the 40% historical cap? **A**: The cap wraps the total historical contribution; evidence bonus is scaled down if necessary so the cap is honored. Cap wins.
- **Q**: pg_trgm? **A**: Out of scope. Existing `lower()` btree handles prefix and substring fine for v1.
- **Q**: Multi-language name matching (e.g. English candidate name vs Japanese broadcast title)? **A**: Out of scope. Name axis is best-effort; category + price are the primary signals.

## 15. Sequel Roadmap

- **Feature C — Pricing Intelligence**: consumes `tv_evidence.price_jpy` distribution, adds Gemini-authored pricing narrative to `PricingStrategy` section. Spec opens after A ships.
- **Feature B — Time-Slot Predictor**: consumes `tv_evidence.top_timeslots`, generates per-channel slot recommendations for new candidates. Spec opens after A ships and shopch+qvc category accuracy is observed for 1–2 months.
