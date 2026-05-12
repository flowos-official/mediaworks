# TV Channel Recommend Sources Design

**Date:** 2026-05-12
**Status:** Draft — pending user review
**Context:** Discovery pipeline (home_shopping)

## Problem

Discovery currently sources candidate products only from Rakuten and generic Brave web search. Users have asked that products **currently listed on the 12 Japanese TV-shopping channels** in `docs/検索参考サイト (2).xlsx` (rows 1–25) also surface in the discovery page, with **TV-channel-listed products always appearing before non-TV-channel candidates** regardless of relative score.

The 12 channels: ショップチャンネル, QVC, 日テレ, TBS, ディノス, ロッピングライフ, せのぶら本舗, らくらく茂, いちばん本舗, カチモ, 買いドキ！マーケット, 関テレ.

Only two of these (`shopch.jp`, `qvc.jp`) are currently scraped by the Broadcast Calendar Phase A pipeline and populate the `broadcasts` table.

## Goals

1. Discovery output includes products that are currently listed on any of the 12 channels.
2. On `/[locale]/analytics/discovery/home`, products with at least one TV-channel match are displayed strictly before products with none. Order between the two groups must not be broken by score sort.
3. Source mix is configurable and fails open: if a TV-channel source returns nothing, the existing Rakuten/Brave behavior is preserved.

## Non-goals

- Writing cheerio scrapers for the 10 channels beyond `shopch.jp`/`qvc.jp`. That belongs to a future Broadcast Calendar Phase B-adjacent spec.
- A per-user "primary channel" preference. Tier ordering inside the TV-channel group is by score, not by channel identity.
- Applying this to the `live_commerce` discovery context. Once stabilized in `home_shopping`, this can be reused.
- Wiring up the dormant `/api/recommend` endpoint or the unused `recommend.*` i18n keys.

## Decision summary

Adopt a **hybrid two-source approach** to populate a new `tv_channel` pool tier:

- **High-fidelity source** — the existing `broadcasts` table (shopch + qvc) is queried for the last 30 days. Each broadcast slot's `description` becomes a PoolItem tagged with its channel.
- **Low-fidelity source** — Brave search with the `site:<domain>` operator for the 10 remaining channels, capped by a daily call budget.

PoolItems from both sources carry `source: "tv_channel"` and a `tvChannel` slug. After scoring, `runStage1` partitions candidates into a TV-channel tier and an "other" tier; the TV tier is always concatenated first. The partition order is persisted via a new `discovered_products.tv_channel_source` column so it survives across API and UI layers.

## Design

### §1. Schema changes

Add a new migration `supabase/migrations/<timestamp>_add_tv_channel_source.sql`:

```sql
ALTER TABLE discovered_products
  ADD COLUMN tv_channel_source text,
  ADD COLUMN tv_tier int
    GENERATED ALWAYS AS (CASE WHEN tv_channel_source IS NULL THEN 1 ELSE 0 END) STORED;

CREATE INDEX discovered_products_tier_idx
  ON discovered_products (session_id, tv_tier ASC, tv_fit_score DESC);
```

`tv_channel_source` is `NULL` when no channel match exists, or **a comma-joined list of channel slugs sorted alphabetically** otherwise (e.g. `"qvc,shopch"`). Alphabetical sort makes the persisted value deterministic so equality checks and dedup are stable.

`tv_tier` is a stored generated column (`0` for TV-channel hits, `1` otherwise) used as the primary sort key. A boolean-shaped key avoids the alphabetical-by-slug ordering trap of sorting on `tv_channel_source` directly.

### §2. Channel registry

New file `lib/discovery/tv-channels.ts`:

```ts
export interface TvChannel {
  slug: string;       // stable identifier persisted in DB
  name: string;       // Japanese display name
  domain: string;     // hostname used for Brave site: search
  scraped: boolean;   // true ⇒ sourced from `broadcasts`, false ⇒ from Brave site:
}

export const TV_CHANNELS: readonly TvChannel[] = [
  { slug: "shopch",   name: "ショップチャンネル",     domain: "shopch.jp",          scraped: true  },
  { slug: "qvc",      name: "QVC",                  domain: "qvc.jp",             scraped: true  },
  { slug: "ntv",      name: "日テレ",                domain: "shop.ntv.co.jp",     scraped: false },
  { slug: "tbs",      name: "TBS",                  domain: "tbs.co.jp",          scraped: false },
  { slug: "dinos",    name: "ディノス",              domain: "dinos.co.jp",        scraped: false },
  { slug: "ropping",  name: "ロッピングライフ",       domain: "ropping.tv-asahi.co.jp", scraped: false },
  { slug: "senobura", name: "せのぶら本舗",          domain: "shop.asahi.co.jp",   scraped: false },
  { slug: "rakurakum",name: "らくらく茂",            domain: "shop.asahi.co.jp",   scraped: false },
  { slug: "ichiban",  name: "いちばん本舗",          domain: "shop.tokai-tv.com",  scraped: false },
  { slug: "kachimo",  name: "カチモ",                domain: "kachimo.jp",         scraped: false },
  { slug: "kaidoki",  name: "買いドキ！マーケット",   domain: "satv.shop",          scraped: false },
  { slug: "kantv",    name: "関テレ",                domain: "ktvolm.jp",          scraped: false },
];
```

Note: せのぶら and らくらく茂 share `shop.asahi.co.jp` but live on different path prefixes. Use `site:shop.asahi.co.jp/category/SENOBURA` / `.../RAKURAKU` as the actual Brave query strings; the `domain` field above is informational.

### §3. Type extensions

`lib/discovery/types.ts`:

- `Source` becomes `"rakuten" | "brave" | "tv_channel"`.
- `PoolItem` gains:
  - `tvChannel?: string` — slug for a single-channel result, OR
  - `tvChannelMatches?: string[]` — populated when the same product was seen on multiple channels (after pool merge).
- `Candidate` gains `tvChannelSource?: string | null` — comma-joined slugs persisted to DB. This is the only TV-channel field the curator and orchestrator read.

### §4. Pool builder

`lib/discovery/pool.ts`'s `buildPool` adds two passes **after** the existing Rakuten and Brave passes (so deduplication merges them into the same accumulator).

**Pass C — broadcasts-derived (shopch, qvc):**

```ts
async function fetchTvChannelFromBroadcasts(
  plan: CategoryPlan,
  windowDays = 30,
): Promise<PoolItem[]>
```

- `SELECT channel, description, thumbnail_url, source_url, air_date FROM broadcasts WHERE air_date >= today - windowDays AND description IS NOT NULL`.
- **Normalize description for comparison only** (the original string is kept for display): NFKC unicode normalization → collapse internal whitespace runs to a single space → trim → lowercase.
- Group by normalized description. Each group accumulates the set of channels that aired it. The group's display `name` is the longest original description seen (preserves type-numbers and full-width chars).
- Filter to descriptions that contain at least one seed keyword (substring match against the normalized form, across `plan.tv_proven ∪ plan.exploration`).
- Emit one `PoolItem` per surviving group: `source: "tv_channel"`, `tvChannel` = first channel in alphabetical order, `tvChannelMatches` = full alphabetical list. Use the most recent slot's `thumbnail_url` and `source_url`.
- Fail-open: on SELECT error, log and return `[]`.

**Pass D — Brave site:-restricted (10 non-scraped channels):**

```ts
async function fetchTvChannelFromBraveSite(
  plan: CategoryPlan,
  channels: TvChannel[],         // filter on `!scraped`
  budget: number,                // total Brave calls allotted
): Promise<PoolItem[]>
```

- Build a (channel × keyword) matrix. Iterate by round-robin (channel cycle, then keyword cycle) so each channel gets coverage before any channel doubles.
- Each call: `q = "<keyword> site:<domain or path-prefix>"`, `count = 5`.
- Stop when `budget` is exhausted.
- Each result is a `PoolItem` with `source: "tv_channel"`, `tvChannel: channel.slug`, `name: brave.title`, `productUrl: brave.url`. No price/category — those are nullable for Brave already.
- Concurrency: 4 in-flight at a time (Brave is tolerant). Per-call timeout already enforced by `braveSearchItems`.
- Default budget: `TV_CHANNEL_BRAVE_BUDGET=50` (env-overridable). With 10 channels and ~15 keywords, this samples 5 calls per channel on average.

**Pool merge / dedup:**

Existing dedup is by `normalizeUrlForDedup(productUrl)`. Two changes:

1. **Brave site:-search items (Pass D)** carry real product URLs, so the existing URL dedup applies unchanged. When a Pass D item collides with an existing Rakuten/Brave pool entry, merge by copying `tvChannel` and `tvChannelMatches` onto the existing entry (so the Rakuten record is upgraded to tier-1). Implementation: keep a `Map<normalizedUrl, PoolItem>` so updates are O(1).
2. **Broadcasts-derived items (Pass C)** have no product URL — `source_url` points to a daily schedule page. They are deduped by **normalized description** within Pass C only. They do **not** merge with Rakuten/Brave items in this milestone (see §11 risks); they enter the pool as their own PoolItems and reach tier-1 on their own.

### §5. Curation passthrough

`lib/discovery/curate.ts` itself does not change. `tvChannel` flows from `PoolItem` → `Candidate.tvChannelSource` via a small mapping step: take `tvChannelMatches` (or `[tvChannel]` if only the singular is set), **sort alphabetically**, join with commas; if neither is set the value is `null`. The alphabetical sort matches the §1 persistence convention so values round-trip identically. This mapping lives in `curate.ts` next to the existing `PoolItem → Candidate` conversion.

The Gemini prompt is not changed in this spec. (Future refinement: tell the curator that tv_channel candidates have an in-product signal, but tier ordering is enforced post-hoc, so the prompt change is not required for this milestone.)

### §6. Orchestrator partition

In `lib/discovery/orchestrator.ts`, immediately after `applyRakutenHotBoost`:

```ts
const tier1 = candidates.filter((c) => c.tvChannelSource);
const tier2 = candidates.filter((c) => !c.tvChannelSource);
tier1.sort((a, b) => b.tvFitScore - a.tvFitScore);
tier2.sort((a, b) => b.tvFitScore - a.tvFitScore);
return {
  candidates: [...tier1, ...tier2],
  plan,
  poolSize: pool.length,
  iterations,
};
```

This is the single enforcement point for the "TV channel first" requirement. Score-based sorts inside each tier preserve existing behavior.

### §7. Persistence

`lib/discovery/save.ts`'s row builder writes `tv_channel_source: candidate.tvChannelSource ?? null`. No other change.

### §8. Read API

`app/api/discovery/today/route.ts` changes the products `.order(...)` to:

```ts
.order("tv_tier", { ascending: true })       // 0 before 1
.order("tv_fit_score", { ascending: false }) // score-DESC inside each tier
```

No new endpoint. The track / status / context query params remain.

### §9. UI changes

`app/[locale]/analytics/discovery/home/page.tsx`:

- After the existing `filtered`/`counts` derivations, partition the visible list into two arrays based on `tv_channel_source` (string or null). Render two `<section>` blocks back-to-back:
  - `📺 TV通販チャネル掲載中 (<n>)` — only rendered when count > 0.
  - `その他の候補 (<n>)` — only rendered when count > 0.
- Sort/filter controls continue to operate on the full set; the partitioning happens after filter/sort so a `score`-sorted list still respects the tier boundary.
- If a user filter (status or sort) produces zero items in a section, hide that section's heading.

`components/discovery/ProductCard.tsx`:

- New optional prop `tvChannelSource?: string | null`.
- When present, render a small badge row above the product name. Each comma-separated slug becomes one badge using `name` from `TV_CHANNELS` lookup. Unknown slugs render the slug itself.
- Badge styling: pill, neutral background, channel name in 12px. No icons in this milestone (icon assets out of scope).

`messages/{en,ja}.json` additions under `discovery`:

```json
"tvChannelSectionTitle": "📺 TV通販チャネル掲載中",
"otherSectionTitle": "その他の候補"
```

### §10. Configuration

New env vars (optional, with safe defaults):

- `TV_CHANNEL_BRAVE_BUDGET` (default `50`) — max Brave site:-search calls per discovery run.
- `TV_CHANNEL_BROADCAST_WINDOW_DAYS` (default `30`) — window for the broadcasts SELECT.

Documented in `CLAUDE.md` under the Broadcast Calendar / Discovery section.

### §11. Error handling and degradation

- Pass C SELECT failure → empty array, warn log, run continues.
- Pass D per-call timeout or non-2xx → individual call skipped, run continues. Aggregated Brave failure rate logged.
- Tier-1 size of 0 → UI renders only the "その他の候補" section; visually identical to today's behavior.
- Migration is additive only — older code reading `discovered_products` continues to work.

### §12. Verification

- Add a regression test `lib/discovery/__tests__/tv-channel-mapping.test.ts` that constructs a synthetic PoolItem with `tvChannelMatches: ["shopch","qvc"]`, runs the curate-step mapping, and asserts `Candidate.tvChannelSource === "shopch,qvc"`. This prevents the field from being silently dropped (analogous to the seed-keyword-vs-category regression).
- `npm run verify:discovery-run` prints a new line: `tv-tier ratio: <n>/<total>`.
- Smoke test before merge: trigger a manual discovery run on a dev DB and confirm the home page renders two sections with at least one product in tier-1.

## Data flow

```
Daily cron (daily-discovery-home)
  └── runStage1(home_shopping)
        ├── buildCategoryPlan         (Gemini, 15 keywords)
        └── buildPool
              ├── Rakuten (sequential, 1.1s throttle)
              ├── Brave general (parallel)
              ├── broadcasts SELECT  (shopch + qvc, 30d)        ← new pass C
              └── Brave site: search (10 channels, budgeted)    ← new pass D
        └── curate → score → applyRakutenHotBoost
        └── partition: tv_channel tier, other tier              ← new
  └── save (with tv_channel_source)
User:
  /analytics/discovery/home
    └── GET /api/discovery/today?context=home_shopping
        └── ORDER BY tv_channel_source NULLS LAST, tv_fit_score DESC
    └── render two sections
```

## Risks and mitigations

- **Brave quota.** Daily budget of 50 calls is modest but additive on top of the existing pool builds. Mitigation: make budget env-tunable; have Pass D fail open. If quota is a recurring concern, drop Pass D entirely (Pass C still ships value for shopch+qvc).
- **Broadcasts description quality.** Some `description` strings include cast/show metadata mixed with product names. Mitigation: limit Pass C inclusion to descriptions whose normalized form contains a seed keyword as substring. False positives are filtered downstream by the existing curator.
- **Duplicate products across tiers (partial).** Pass D (Brave site:) shares URL dedup with the existing pool, so a product found on both Rakuten and a Brave-discovered TV-channel page collapses correctly into a tier-1 entry. Pass C (broadcasts) does **not** share a URL with Rakuten/Brave items — its identity is the product description — so the same physical product can appear as one tier-1 broadcasts-derived candidate AND one tier-2 Rakuten candidate. This is accepted for this milestone; users see the tier-1 broadcast version first, and the duplicate is visible but acceptable. A future spec can add name-based fuzzy dedup if duplicates become noisy in practice.
- **Markup change on a scraped channel** would silently zero out Pass C for that channel. Already covered by Phase A's `health.expectedNonZero` warning.

## Open follow-ups (out of scope)

- Implement cheerio scrapers for the 10 remaining channels (Phase B-style).
- Per-channel weighting (a "primary channel" first among tier-1 items).
- Apply the same partition to `/analytics/discovery/live`.
- Surface channel match metadata in the product detail page.
