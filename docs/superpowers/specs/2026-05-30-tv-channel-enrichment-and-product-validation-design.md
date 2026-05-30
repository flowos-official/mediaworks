# TV-channel candidate enrichment + product-page validation (P1-6) — make the discovery pool's category/price real

- **Date**: 2026-05-30
- **Status**: Design (grounded by a 2-lens code+live investigation; pre-implementation)
- **Area**: Discovery ingest (`lib/discovery/{pool,save,curate,tv-channel-enrich}.ts`), discovery cron, category normalization
- **Related**:
  - `2026-05-30` MD-recommendation intent fixes (merged): category/price now honored as a *filter*, but the pool the filter runs on is data-poor — this spec fixes the data.
  - 2-pass MD-recommendation review + P1-6 grounding investigation (wfy539rn3).
- **Memory**: `[[project-md-recommendation-ignores-category-price]]`, `[[project-discovery-optimizes-exposure-not-sales]]`, `[[project-two-channel-registries]]`

## Problem

The `discovered_products` pool that feeds both `/analytics/discovery/home` and the MD strategy recommendation is **data-poor for the highest-priority rows**. Live (2026-05-30): of 356 `tv_channel` rows, **356 (100%) have NULL `category`, 314 (88%) NULL `price_jpy`, 340 (95%) NULL `thumbnail_url`**. Because the pool sorts `tv_tier ASC` (TV first), these data-poor rows fill the top of every query, so the operator's category/price filters operate on rows that are NULL in exactly those fields. The 2026-05-30 code fixes made the *filters* correct; this spec makes the *data* they filter on exist.

**Root cause (verified, file:line):**
1. `tv_channel` candidates are built from a Brave search result's `{title, url}` ONLY — no page is fetched at ingest, so `priceJpy`/`category`/`thumbnailUrl` are never set (`lib/discovery/pool.ts:246-258`). They flow through `curate.ts::poolItemToCandidate` and `save.ts::buildDiscoveredProductRows` (`save.ts:173-174` writes `candidate.* ?? null`) → both land NULL by construction.
2. `lib/discovery/tv-channel-enrich.ts` (`fetchAndParseMetadata` → `{thumbnail,price,category,description}`) is **dead in the cron path** — its only importer is the hand-run `scripts/enrich-tv-discoveries.ts`.
3. The cron's inline `save.ts::enrichMissingCategories` IS run, but its target filter is **hard-gated to Rakuten** (`!category && source==='rakuten' && url.includes('rakuten.co.jp')`, `save.ts:205-213`), so `tv_channel` rows are structurally skipped.
4. Non-product **listing/landing pages leak** into the pool (japanet `/shopping/cooking-appliances/`, dinos `/tv/ranking/`, kachimo `/collections/…`, corporate pages). The `isNonProductPage` marker filter (added 2026-05-30) is conservative-by-design and does not catch these path shapes — its own header defers "JSON-LD `@type=Product` detection at scrape time" to this spec.

## Goal

For `tv_channel` (Brave-sourced) discovery candidates: **persist a real `category` and `price_jpy` at ingest**, **reject non-product pages**, and **store the category in a vocabulary the pool filter can actually match** — so an operator's category/price request returns real, in-band products instead of an unfiltered wall of metadata-less TV rows.

## Non-goals

- Re-architecting the scraped-channel calendar pipeline (`broadcasts`/QVC/ShopCh) — unaffected.
- Per-candidate `tvFitScore` changes — untouched (consistent with the discovery-audit constraint).
- JS-rendered channels that expose nothing to a static fetch (`ropping`, `tv-tokyoshop`, `shop.asahi.co.jp` → HTTP 400 to a cheerio UA): best-effort only; they stay NULL (no worse than today) rather than being force-dropped. A Playwright path is out of scope.

## Key findings that shape the design

- **No single page signal works across the ~14 channels.** Strong JSON-LD `@type=Product` (+ `og:price`, sometimes `category`/breadcrumb): `ktvolm`, `shop.tokai-tv.com`, Shopify `kachimo`. NO structured data: `tbs`/`ntv` (`@type=article`, price only as visible `NNN円` text), `ropping` (`@type=WebSite`, JS-rendered), `tv-tokyoshop` (SPA shell). `shop.asahi.co.jp` returns HTTP 400 to the current fetcher.
- **`@type=Product` / `og:type=product` is a reliable POSITIVE signal but its ABSENCE is not a reliable reject** — it would false-reject the article/SPA channels' real products. So validation must be tiered (accept on a positive signal; for weak hosts, accept only if a yen price is extractable; reject the rest).
- **Category needs a classifier, not just scraping** — only `ktvolm` exposed `Product.category` (1/5 sampled). Name/`og:description`-based Gemini classification is required for the rest.
- **CRITICAL — taxonomy bridge.** The channel whitelist vocabulary (`ビューティ`, `ホーム・キッチン`, `家電`, …; `channel_categories` + `category-normalize`) is NOT the vocabulary the pool filter matches against. `pool-query.ts::applyFilters` does `hay = r.category; matchTerms.some(t => hay.includes(t))`, where `matchTerms = buildCategoryMatchTerms(uiCategory)` produces the **sales** taxonomy (`美容・スキンケア → ['美容','スキンケア','美容・運動','化粧品']`; `キッチン用品 → ['キッチン']`). Storing `ビューティ` on a row would NOT match a `美容・スキンケア` request (no term is a substring of `ビューティ`). **The persisted category must be in the sales taxonomy** (or the filter must expand `r.category` too). This is the difference between this spec working and silently not working.
- **Charset bug.** `tv-channel-enrich.ts` uses `res.text()` (assumes UTF-8); Shift_JIS hosts (japanet) return mojibake → unusable name/description for the classifier. Must decode per `Content-Type` / `<meta charset>`.
- **No schema change needed.** `discovered_products.{category,price_jpy,thumbnail_url}` already exist; only a writer is missing.

## Chosen approach (components)

### 1. Ingest-time fetch + enrich for `tv_channel` rows
Revive and harden `tv-channel-enrich.ts::fetchAndParseMetadata` and run it during the daily cron — **generalize `save.ts::enrichMissingCategories`** so its target filter also matches `source==='tv_channel'`, dispatching non-rakuten URLs to `fetchAndParseMetadata` (keep `fetchRakutenPage` for rakuten URLs). Reuse the existing concurrency-worker + `categoryEnrichmentDeadlineMs` budget so it stays inside the 300s cron window. Set recovered `price_jpy`/`thumbnail_url`/`category`/`description` onto `candidate` *before* `buildDiscoveredProductRows`. (Evidence: the parser already recovers price 3/5 + thumbnail 4/5 immediately.)

### 2. Product-page validation (tiered) at ingest
After `isNonProductPage(title,url)` (cheap prefilter) and the page fetch, accept/reject from the HTML (ground truth):
- **ACCEPT** if JSON-LD `@type=Product` present OR `og:type='product'`.
- For structurally-weak hosts (`og:type ∈ {article, website}`, no Product schema): **ACCEPT only if a yen price is extractable** from `og:price`/`itemprop`/visible `NNN円` DOM text; otherwise **REJECT**.
- This cleanly drops the confirmed leaks (japanet landing, `/category/` terminal, dinos `/tv/` landings, kachimo `/collections/`, corporate hosts) while keeping tbs/ntv (price-in-text) products.
- Also extend `non-product-filter.ts` URL rejects for the observed shapes: `/collections/`, terminal `/category/`, `/tv/{landing}`, `/shopping/$` roots, and `corporate.*` / `*/company` hosts. (Keep it conservative — these are terminal/host-level, not the nested `/category/{id}.html` product paths that the 2026-05-30 fix deliberately preserved.)

### 3. Category extraction → normalization → **sales-taxonomy bridge**
Priority order, reusing existing code:
1. `lib/qvc-products/fetcher.ts::extractCategoryFromHTML` (JSON-LD `Product.category` → top segment, BreadcrumbList/DOM fallback, home-crumb skip) — handles `ktvolm`-shaped pages.
2. Fallback for no-structured-category hosts: a Gemini batch name-classifier modeled on `lib/broadcasts/shopch-category.ts` (batch the day's NULL-category `tv_channel` rows; classify `name` + `og:description` → whitelist).
3. `lib/discovery/category-normalize.ts::normalizeCategoriesBatch` (cache-backed via `discovered_category_normalization`) to land a consistent whitelist value.
4. **Bridge to sales taxonomy (mandatory):** before persisting, map the normalized whitelist value through `CATEGORY_ALIASES_TO_SALES` (`category-mapping.ts`: `ビューティ→化粧品/美容・運動`, `ホーム・キッチン→キッチン`, `家電→家電・雑貨`) so `discovered_products.category` holds a term that `buildCategoryMatchTerms` output substring-matches. *(Preferred over changing `pool-query.ts::applyFilters` to expand `r.category` — keeps the filter untouched and lower-risk. Decision recorded below.)*

### 4. Charset fix
In `fetchAndParseMetadata`, decode the response per `Content-Type` charset / `<meta charset>` (Shift_JIS, EUC-JP) instead of bare `res.text()`, so Japanese name/description survive for the classifier.

### 5. Backfill existing rows
Extend `scripts/enrich-tv-discoveries.ts`: drop the thumbnail-null gate, add the classifier-based category fill + the sales-taxonomy bridge, flag/soft-delete confirmed non-product rows, then run once over the ~356 existing `tv_channel` rows. Optionally a lightweight `metadata_enriched_at timestamptz` column (or reuse a status flag) for observability — no new lifecycle table.

## Data flow (target)

```
Brave site: hit {title,url}
  → isNonProductPage(title,url) cheap prefilter (existing)
  → ★ fetch product page (charset-aware)                      ← NEW
  → ★ product-page validation (JSON-LD @type=Product / og:type / price-in-text) ← NEW
        ├─ reject → drop (listing/landing/corporate)
        └─ accept → extract {price, thumbnail, description, rawCategory}
  → ★ category: extractCategoryFromHTML ?? Gemini name-classify ← NEW
  → ★ normalizeCategoriesBatch → whitelist value               ← NEW
  → ★ CATEGORY_ALIASES_TO_SALES bridge → sales taxonomy term    ← NEW (the load-bearing step)
  → candidate.{price_jpy,category,thumbnail_url} set
  → buildDiscoveredProductRows → discovered_products (now filterable)
```

## Edge cases & risks

- **JS-rendered / 400 channels** (`ropping`, `tv-tokyoshop`, `shop.asahi`): stay NULL; acceptable (no worse than today). Track per-channel recovery rate; a Playwright fetch is a separate follow-up if these channels matter.
- **Cron 300s budget**: per-candidate HTTP fetch + a Gemini classify batch adds latency. Reuse the existing deadline budget; cap fetches per run and let the rest enrich on the next cron / backfill. Log what was skipped (no silent truncation).
- **Gemini cost**: batch-classify only NULL-category rows; cache via `discovered_category_normalization` so repeats are free.
- **Taxonomy bridge correctness**: if the `CATEGORY_ALIASES_TO_SALES` map lacks a whitelist→sales entry, the row gets an unmatched category. Add an acceptance test asserting a normalized `ビューティ` row is returned by a `美容・スキンケア` pool query.
- **Validation false-negatives**: the price-in-text fallback may still drop a real product with no price anywhere; accept this (NULL row, not a wrong row) over re-admitting listing pages.
- **Charset detection**: prefer the HTTP `Content-Type` header; fall back to `<meta charset>`; default UTF-8.

## Decisions

1. Persist the **sales-taxonomy** value on `discovered_products.category` (bridge via `CATEGORY_ALIASES_TO_SALES`), NOT the raw channel-whitelist value — keeps `pool-query.ts` untouched.
2. Validation is **tiered** (Product-schema/og:type accept; price-in-text accept for weak hosts; else reject), not a single `@type=Product` gate (which false-rejects article/SPA channels).
3. Enrichment runs **at ingest in the cron** (generalized `enrichMissingCategories`), with the manual script extended only for the one-time backfill.
4. No schema change required (reuse existing columns); optional `metadata_enriched_at` for observability.

## Out of scope (separate follow-ups)

- Playwright/headless fetch for JS-rendered channels (`ropping`, `tv-tokyoshop`, `shop.asahi`).
- `pool-query.ts` `count(DISTINCT product_url)` denominator refinement.
- Applying the same enrichment to `rakuten_room` rows mis-tagged `source='tv_channel'` (noted by the investigation; small follow-up).

## Verification plan

- Unit: `extractCategoryFromHTML` + the new validation predicate against saved fixtures for ktvolm (Product), tbs (article+price-text), japanet (listing → reject).
- Bridge test: a row stored via the new path with a `美容`-class product is returned by `queryDiscoveredPool({uiCategory:"美容・スキンケア"})`.
- Live acceptance (mirrors the 2026-05-30 MD acceptance): after backfill, re-run `discoverNewProducts({explicitCategory:"美容・スキンケア", priceRange:"3000-30000"})` and confirm tv_channel results now carry real category/price and the listing-page leak is gone.
- Charset: japanet page yields readable Japanese name/description (no mojibake).
- Observability: per-channel enrichment recovery rate logged by the cron.
