# Live Commerce Discovery Redesign

**Date:** 2026-05-24
**Status:** Design
**Predecessor commit:** `f2727f5 feat(discovery/live): use live-commerce platforms, drop TV signals` (this design supersedes it)

## 1. Goal

Replace the live-commerce discovery pipeline so it actually reflects Japan's 2026 live-commerce reality, rather than running the home-shopping pipeline with the TV signals turned off.

Outcome: when a user opens `/analytics/discovery/live`, the surfaced products fit the categories, price band, audience, and creator-affinity profile of Japanese live commerce — not generic Rakuten listings with a few weak channel hits.

## 2. Background: why the previous attempt fell short

A first pass (commit `f2727f5`) reused the home-shopping pipeline, swapped the TV-channel registry for a "live channel" registry of 5 platforms, removed all TV-broadcast post-processing layers, and added a `room.rakuten.co.jp` boost.

External verification (WebSearch, May 2026) found that 4 of the 5 registered platforms are inappropriate for sourcing:

| Slug in `f2727f5` | Status verified |
|---|---|
| `rakuten_live` (live.rakuten.co.jp) | Service ended 2021-04-30. Domain resolves but holds no live-commerce content. |
| `mercari_shops` (mercari-shops.com) | Mercari Channel ended 2019-07. Mercari Shops is a storefront platform — not live commerce. |
| `17live_shop` (17.live) | 17LIVE is live streaming. Its commerce arm (HandsUP) is a SaaS embedded into merchant sites — no central catalog to crawl. |
| `pinkoi_live` (pinkoi.com) | Taiwan-based handmade marketplace, marginal in Japan LC. |
| `rakuten_room` (room.rakuten.co.jp) | Active. Valid signal. |

In addition, the categories baked into the live-commerce prompts (`化粧品 / ファッション小物 / 美容家電 / ガジェット / 季節限定品 / トレンド雑貨`) carry TV-shopping residue (`美容家電`, `ガジェット`) and miss two of TikTok Shop Japan's top-4 GMV categories as of November 2025 (`食品・ドリンク`, `おもちゃ・ホビー`).

The Japanese live-commerce market itself is fragmented and hostile to centralized crawling: 楽天LIVE / メルカリチャンネル / Yahoo!ショッピングLIVE / BASELive have all shut down, the active SaaS players (HandsUP, Tig LIVE, Live Kit, Lキャスト) embed into merchant sites, and TikTok Shop Japan (the largest new entrant since 2025-06-30) actively resists crawling. Treating live commerce as "TV shopping with a younger audience" gives wrong recommendations.

## 3. Non-goals

- No schema migration. `tv_channel_source` and `tv_tier` columns continue to carry live-channel slugs (semantic mismatch accepted — a future rename to `channel_source` / `channel_tier` is left for after the signal model stabilizes).
- No separate live-commerce orchestrator / pipeline. The existing `runStage1` stays the single entry point — only the `context === 'live_commerce'` branches change.
- No new home-shopping cron changes. The home pipeline is correct as-is and is not touched.
- No multi-language support changes. Live UI continues to use existing next-intl strings.
- No persistence schema additions beyond reusing existing columns and annotation patterns inside `tv_fit_reason`.
- No TikTok Shop Japan ingestion as a pool source. TikTok Shop product pages resist Brave indexing; the platform participates only as a creator-content boost signal (§ 5.4).

## 4. Architecture

### 4.1 Data flow

```
GET /api/cron/daily-discovery-live
  │
  ├── runStage1(learning, TARGET_COUNT, 'live_commerce')
  │       plan.ts        — TikTok Shop JP-aligned categories, ¥1,000–8,000 zone
  │       pool.ts        — Pass D uses LIVE_CHANNELS (2 platforms), Pass C skipped
  │       curate.ts      — live-context block, ¥1,000–8,000 / fashion ¥1,000–12,000
  │       partitionByTier — live channel hits → tier-0
  │
  ├── baseline = snapshot tvFitScore per candidate
  │
  ├── Promise.all
  │       runOptionalStage(L1 · ROOM mention boost)
  │       runOptionalStage(L2 · Rakuten Shopping Channel archive boost)
  │       runOptionalStage(L3 · Creator content (YouTube + TikTok) boost)
  │       runOptionalStage(L4 · Hashtag mention boost)
  │
  ├── clampLiveBoosts(candidates, baseline, +15)
  ├── re-sort by tvFitScore desc
  │
  ├── saveDiscoveredProducts(sessionId, batch with broadcastTag='unknown', tvEvidence=null)
  ├── finalizeSession
  └── revalidateTag('discovery:live_commerce'), revalidateTag('discovery:history')
```

The TV-shopping post-processing chain (`applyBroadcastBoost`, `tagBroadcastEvidence`, `applyRecentBroadcastPenalty`, `applyCompetitorTrendBoost`, `applyEvidenceBonus`, `computeTvEvidence`) is **not invoked** for `context === 'live_commerce'`. All five layers carry QVC/ShopCh-centric signals that do not apply to live commerce.

### 4.2 File changes

```
lib/discovery/live-channels.ts            — rewritten (2 entries, see §5.1)
lib/discovery/pool.ts                     — no further change (context branching already in place from f2727f5)
lib/discovery/orchestrator.ts             — no further change
lib/discovery/plan.ts                     — live_commerce contextGuidance block rewritten
lib/discovery/curate.ts                   — live_commerce contextBlock rewritten
lib/discovery/rakuten-room-boost.ts       — kept as-is (already implemented in f2727f5)
lib/discovery/rakuten-live-archive-boost.ts   — new (§ 5.3)
lib/discovery/creator-content-boost.ts    — new (§ 5.4)
lib/discovery/hashtag-mention-boost.ts    — new (§ 5.5)
lib/discovery/live-boost-clamp.ts         — new (§ 5.6)
app/api/cron/daily-discovery-live/route.ts — replaces L1-only post-processing
                                              with L1+L2+L3+L4 + clamp
scripts/test-live-boost-layers.ts         — new (§ 7)
scripts/test-live-channels-registry.ts    — new (§ 7)
```

## 5. Components

### 5.1 `LIVE_CHANNELS` registry

```typescript
// lib/discovery/live-channels.ts
export const LIVE_CHANNELS: readonly LiveChannel[] = [
    { slug: "rakuten_room",
      name: "Rakuten ROOM",
      siteQuery: "room.rakuten.co.jp",
      scraped: false },
    { slug: "rakuten_shopping_channel",
      name: "楽天市場ショッピングチャンネル",
      siteQuery: "event.rakuten.co.jp/campaign/live-shopping",
      scraped: false },
];
```

Removed from the previous commit: `rakuten_live`, `mercari_shops`, `17live_shop`, `pinkoi_live`. Rationale recorded in §2.

`LIVE_CHANNEL_BRAVE_BUDGET` default lowered from 100 to 80 — Pass D now covers 2 channels instead of 5.

### 5.2 Category & price prompts

#### `plan.ts` — live_commerce `contextGuidance`

```
【Context: ライブコマース (日本市場 2026)】
- ターゲット: 20-40代女性中心、SNS/動画ネイティブ、クリエイター追従購買層、即決層
- カテゴリ優先 (TikTok Shop JP 2025-11 GMV実績ベース):
  1. 美容・パーソナルケア (化粧品/スキンケア/ヘアケア/フレグランス)
  2. 食品・ドリンク (お菓子/健康ドリンク/調味料/コーヒー紅茶/産直)
  3. レディースファッション (アパレル/小物/アクセサリー — トレンド寄り)
  4. おもちゃ・ホビー (キャラクター/コレクター/DIY/ペット用品)
  5. 生活トレンド雑貨 (キッチン雑貨/インテリア小物 — ビジュアル映え必須)
- 価格帯: ¥1,000-8,000 (即決インパルスゾーン、ファッションのみ¥12,000まで許容)
- 重視: ビジュアル/動画映え、クリエイター親和性 (アフィリエイト/レビュー動画作成しやすい)、SNS拡散性、リアルタイム購買トリガー (限定/タイムセール訴求)
- 除外: 設置必須の家電、高額耐久財、医薬品、TV実演前提商品、高齢者専用商品
```

#### `curate.ts` — live_commerce `contextBlock`

```
【Context: ライブコマース (20-40代女性、SNS/動画ネイティブ、クリエイター追従層)】
- 重視: ビジュアル/動画映え、クリエイター親和性、SNS拡散性、インパルス価格帯フィット、リアルタイム購買トリガー (限定/タイムセール)
- 価格帯ゾーン: ¥1,000-8,000 (即決インパルス) / ファッションのみ ¥1,000-12,000
- カテゴリ重み (TikTok Shop JP実績):
  ★★★ 美容・パーソナルケア / 食品・ドリンク
  ★★  レディースファッション / おもちゃ・ホビー
  ★   生活トレンド雑貨
- 除外特性: 設置必須家電、高額耐久財、医薬品、TV実演必須商品、高齢者専用商品、機能訴求のみで視覚要素が弱い商品
```

`curate.ts` score weights (review_signal 15 / tv_category_match 30 / trend_signal 15 / price_fit 20 / purchase_signal 20) remain unchanged. The narrower price band (¥1,000–8,000 vs prior ¥1,000–15,000) does the de-prioritization of TV-priced items via the existing `price_fit` calculation; no rubric rewrite needed.

### 5.3 L2 · Rakuten Shopping Channel archive boost

```typescript
// lib/discovery/rakuten-live-archive-boost.ts
export async function applyRakutenLiveArchiveBoost(candidates: Candidate[]): Promise<number>
```

- **Method:** 1–3 bulk Brave queries against `site:event.rakuten.co.jp/campaign/live-shopping`. Extract `item.rakuten.co.jp/<shop>/<item>/` patterns from result URLs and descriptions, building a `Set<string>` of `shopCode:itemCode` keys. If Brave's body excerpt doesn't expose product links, fall back to WebFetch on the top 1–2 result pages and parse for `item.rakuten.co.jp` links there.
- **Match:** A candidate is boosted iff its `rakutenItemCode` is in the Set.
- **Boost:** `+5` (env: `RAKUTEN_LIVE_ARCHIVE_BOOST`).
- **Annotation:** `[楽天LIVE放送実績あり]` appended to `tvFitReason`.
- **Cost:** 3 Brave calls per cron run (independent of candidate count).
- **Fail-open:** any Brave/WebFetch error → empty Set → no boost applied, no error propagated.

This layer differs from the per-candidate pattern because the archive page surface is small and predictable. One bulk fetch is cheaper than 30 per-candidate queries and yields a higher-quality signal (boost only when there's an actual Rakuten LIVE broadcast tied to the exact `itemCode`).

### 5.4 L3 · Creator content boost (YouTube + TikTok)

```typescript
// lib/discovery/creator-content-boost.ts
export async function applyCreatorContentBoost(candidates: Candidate[]): Promise<number>
```

- **Method:** For each candidate up to `CREATOR_CONTENT_BOOST_CAP` (default 30), one Brave query: `"<name slice 40>" (site:youtube.com OR site:tiktok.com)`.
- **Noise filter:** Count only hits whose title contains ≥ 2 product-name tokens (split on whitespace + punctuation, drop tokens < 2 chars). Prevents false positives from generic YouTube/TikTok pages that happen to mention a keyword.
- **Boost (tiered):** `hits ≥ 1 → +3` (env: `CREATOR_CONTENT_BOOST_TIER1`), `hits ≥ 3 → +5` (env: `CREATOR_CONTENT_BOOST_TIER2`).
- **Annotation:** `[YouTube/TikTok言及 N件]` where N = capped at 5.
- **Concurrency:** 4 workers.
- **Cost:** ~30 Brave calls per cron run.
- **Fail-open:** per-candidate Brave failure logged + skipped, no cascading failure.

### 5.5 L4 · Hashtag mention boost

```typescript
// lib/discovery/hashtag-mention-boost.ts
export async function applyHashtagMentionBoost(candidates: Candidate[]): Promise<number>
```

- **Method:** For each candidate up to `HASHTAG_MENTION_BOOST_CAP` (default 30), one Brave query: `"<name slice 40>" ("#ライブで紹介" OR "#ライブコマース" OR "ライブで紹介")`.
- **Boost:** `+5` (env: `HASHTAG_MENTION_BOOST`) when hits ≥ 1.
- **Annotation:** `[ライブ紹介ハッシュタグ言及]`.
- **Concurrency:** 4 workers.
- **Cost:** ~30 Brave calls per cron run.
- **Fail-open:** same pattern as L3.

X (Twitter) is poorly indexed by Brave in Japan; expected hits come from Instagram/Threads/blog mirrors. This is acceptable — the hashtag itself supplies the live-commerce context regardless of which medium carries it.

### 5.6 Live boost clamp

```typescript
// lib/discovery/live-boost-clamp.ts
export function clampLiveBoosts(
    candidates: Candidate[],
    baselineByUrl: Map<string, number>,
    cap: number,
): void
```

- **Method:** Computes `delta = candidate.tvFitScore - baselineByUrl.get(candidate.productUrl)`. If `delta > cap`, sets `tvFitScore = min(100, baseline + cap)` and appends `[合算cap+${cap}]`.
- **Default cap:** `15` (env: `LIVE_BOOST_TOTAL_CAP`).
- **Pure function:** mutates candidates in place, no async, no side effects beyond mutation.

Rationale: each layer's individual cap is `+5`, so with all 4 layers firing at their ceiling the natural max delta is `+20` (L1 +5, L2 +5, L3 tier-2 +5, L4 +5). A `+15` clamp deliberately caps below that ceiling so no single candidate can monopolize the score band purely by accumulating boosts. The clamp also guards against (a) future tuning that raises per-layer caps and (b) signal-correlated noise where a single SEO-spam page triggers multiple layers.

### 5.7 Cron flow (rewrite of `app/api/cron/daily-discovery-live/route.ts`)

```typescript
const orchestrated = await runStage1(learning, TARGET_COUNT, "live_commerce");
await attachPlanToSession(sessionId, orchestrated.plan);

const baseline = new Map(
    orchestrated.candidates.map((c) => [c.productUrl, c.tvFitScore]),
);

await Promise.all([
    runOptionalStage({ label: "live:L1-room", startedAtMs, deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
        minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS, fallback: null,
        task: async () => { await applyRakutenRoomBoost(orchestrated.candidates); return null; } }),
    runOptionalStage({ label: "live:L2-archive", /* ... */
        task: async () => { await applyRakutenLiveArchiveBoost(orchestrated.candidates); return null; } }),
    runOptionalStage({ label: "live:L3-creator-content", /* ... */
        task: async () => { await applyCreatorContentBoost(orchestrated.candidates); return null; } }),
    runOptionalStage({ label: "live:L4-hashtag", /* ... */
        task: async () => { await applyHashtagMentionBoost(orchestrated.candidates); return null; } }),
]);

clampLiveBoosts(orchestrated.candidates, baseline, LIVE_BOOST_TOTAL_CAP);
orchestrated.candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);

const batch = orchestrated.candidates.map((c) => ({
    candidate: c,
    broadcastTag: "unknown" as const,
    broadcastSources: [],
    tvEvidence: null,
}));
// ... saveDiscoveredProducts → finalizeSession → revalidateTag
```

#### Concurrency safety

The four boost layers run in parallel via `Promise.all`. Each layer mutates `candidate.tvFitScore += boost` on shared candidate objects. This is safe because:

1. JavaScript is single-threaded: `+=` on a field is atomic relative to any other JS execution.
2. Each layer's internal worker pool iterates over candidates independently; two layers writing to the same candidate field interleave only at `await` boundaries, never mid-statement.
3. Per-layer `Math.min(100, ...)` caps are computed against the field's value at that moment — another layer's later boost may temporarily push past one layer's intended ceiling, but `clampLiveBoosts` runs after all four complete and enforces the final cap.

No locks or atomic primitives are needed.

## 6. Daily Brave-call budget

```
Pool Pass D (LIVE_CHANNELS, 2 platforms)   ~80
Rakuten crossmatch                          0   (not applied for live)
L1 · ROOM mention                          30
L2 · Rakuten LIVE archive                   3
L3 · Creator content                       30
L4 · Hashtag mention                       30
───────────────────────────────────────────────
Total                                     ~173 calls / day
```

Lower than the home cron's ~250–300 calls/day. Comfortable inside Brave's free-tier daily quota.

## 7. Verification & observability

### 7.1 Day-0 manual verification

1. **Dry-run script `scripts/test-live-boost-layers.ts`:** synthesises 5 fake candidates spanning the four boost-eligibility profiles plus a noise candidate; runs each layer individually; asserts that only the intended candidates receive each layer's annotation and score delta, and that `clampLiveBoosts` correctly caps a synthetic 4-signal candidate at `+15`.
2. **Cron manual trigger:** `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/daily-discovery-live`. Confirm:
   - response `producedCount` close to `TARGET_COUNT` (default 30)
   - response `poolSize` > 0
   - response time < 270s
3. **DB inspection query** (latest session):

   ```sql
   SELECT
       tv_channel_source,
       COUNT(*) AS n,
       AVG(tv_fit_score) AS avg_score,
       STRING_AGG(DISTINCT
           CASE
               WHEN tv_fit_reason LIKE '%[ROOM言及あり]%' THEN 'L1'
               WHEN tv_fit_reason LIKE '%[楽天LIVE放送実績あり]%' THEN 'L2'
               WHEN tv_fit_reason LIKE '%[YouTube/TikTok言及%' THEN 'L3'
               WHEN tv_fit_reason LIKE '%[ライブ紹介ハッシュタグ言及]%' THEN 'L4'
           END, ','
       ) AS layers_hit
   FROM discovered_products
   WHERE session_id = '<latest-live-session-id>'
   GROUP BY tv_channel_source
   ORDER BY n DESC;
   ```

   Pass criteria: at least one row with `tv_channel_source = 'rakuten_room'`, at least one annotation among L1–L4 present, and **zero** rows with TV-layer annotations (`[放送実績あり]`, `[QVC直近30日放送あり]`, `[他局トレンド: ...]`).
4. **UI check** at `/[locale]/analytics/discovery/live`: 美容 / 食品 / レディースファッション dominate the top results; prices cluster in ¥1,000–8,000; no `美容家電` or `ガジェット`.

### 7.2 Day-1+ daily monitoring

- **Category distribution (5-day rolling):** top categories should be dominated by 美容 / 食品 / patterns. Red flag: 家電 in top 5, or 美容 + 食品 + ファッション combined < 50%.
- **Boost layer hit rates (14-day rolling, per-layer per-day):** any layer with 14 consecutive zero days indicates a stale query pattern or upstream site structure change. Red flag.
- **Clamp invocation rate:** `[合算cap+15]` annotations should be 0–1 per day under normal conditions. > 5/day suggests over-correlated signals; revisit per-layer caps.
- **Brave budget tracking:** scan Vercel logs for stage labels (`live:L1-room`, etc.); total daily calls should stay near 173.
- **Sourcing feedback loop:** existing `discovery:product-actions` flow. Two-week target: at least some `interested` / `rejected` / `sourced` actions on live candidates so `feedback_sample_size` accumulates. Zero accumulation = users aren't engaging with results.

### 7.3 Failure modes & first response

| Symptom | Probable cause | First response |
|---|---|---|
| `poolSize = 0` | Brave API down or `LIVE_CHANNELS` site:search empty | Verify `BRAVE_SEARCH_API_KEY`; temporarily raise `LIVE_CHANNEL_BRAVE_BUDGET` |
| All boost layers 0 hits | Brave daily quota exhausted | Recovers next day; can also temporarily lower `*_CAP` |
| `producedCount < 10` | Category prompt too narrow → pool starvation | Raise `learning_state.exploration_ratio`; expand `FALLBACK_EXPLORATION` |
| Categories skew away from 美容/食品 | Gemini ignoring prompt priority | Strengthen `★★★` priority phrasing; recompute `loadTopCategories` data |
| TV annotations reappear | TV layer accidentally invoked | grep cron file for `applyBroadcastBoost`, `tagBroadcastEvidence` calls — must be 0 |
| Clamp fires daily on many rows | 4-signal correlation is real | Accept (popular products) — but if > 5/day, raise `LIVE_BOOST_TOTAL_CAP` |

### 7.4 Test scripts

- `scripts/test-live-channels-registry.ts` — pings each `LIVE_CHANNELS` siteQuery for 200 OK (live network check).
- `scripts/test-live-boost-layers.ts` — Day-0 dry-run described in §7.1.
- `scripts/test-live-cron-dry-run.ts` — runs `runStage1('live_commerce')` only (no DB write) and inspects category/price distribution.

Existing gates remain:
- `npx tsc --noEmit` — 0 errors after the change.
- `npm run lint` — 0 errors on touched files (pre-existing 30 warnings are unchanged).

## 8. Environment variables

```bash
# Existing (carried forward, defaults shown)
LIVE_CHANNEL_BRAVE_BUDGET=80              # was 100; lowered as registry shrunk to 2 platforms
RAKUTEN_ROOM_BOOST=5
RAKUTEN_ROOM_BOOST_CAP=30
RAKUTEN_ROOM_BOOST_CONCURRENCY=4

# New
RAKUTEN_LIVE_ARCHIVE_BOOST=5
CREATOR_CONTENT_BOOST_CAP=30
CREATOR_CONTENT_BOOST_TIER1=3
CREATOR_CONTENT_BOOST_TIER2=5
CREATOR_CONTENT_BOOST_CONCURRENCY=4
HASHTAG_MENTION_BOOST=5
HASHTAG_MENTION_BOOST_CAP=30
HASHTAG_MENTION_BOOST_CONCURRENCY=4
LIVE_BOOST_TOTAL_CAP=15
```

## 9. Open questions

None blocking implementation. Three deferred items, documented for future tuning:

1. **Schema rename `tv_channel_source` → `channel_source`.** Deferred until signal model stabilizes (~4 weeks of production data).
2. **TikTok Shop Japan as a pool source.** Deferred — would need a separate ingestion path (their product pages resist Brave indexing). Re-evaluate if TikTok Shop GMV in Japan continues climbing.
3. **HandsUP-deployed merchant pages.** No centralized registry. Could be sourced via partner outreach later, not via crawling.
