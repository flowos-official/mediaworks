# OA Channel Image Enrichment — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-05-21
**Scope**: Add product thumbnails to the 7 OA channels with feasible image extraction paths (txd, junsanpo, tbs, senobura, uranoura, dinos, ntv) so the `/[locale]/broadcasts` calendar's day-detail panel renders thumbnails next to OA slot rows — matching the visual richness QVC/ShopCh already have. `japanet` is excluded (no `source_url` collected; needs a separate parser-strategy follow-up).

---

## 1. Goal

Today the calendar's `UnifiedDayDetailPanel` renders QVC/ShopCh with rich content (thumbnails, descriptions, video links) because the `broadcasts` table carries that metadata. OA channels in `historical_broadcasts` render text-only — no image. This spec brings image_url enrichment to 7 of the 8 OA channels via channel-specific extraction strategies, all relying on lightweight HTTP/JSON fetch (no browser/Playwright in production).

After this change:

- **Daily cron** automatically enriches new slots as it scrapes them (forward-going).
- **One-shot backfill script** enriches the ~47k existing rows that landed before this change (operator-triggered, idempotent, channel-scoped).
- **UI** shows a 48×48 thumbnail next to each OA row when `image_url` is set; rows without images render unchanged (current state).

## 2. Non-Goals

- **`japanet`** — the existing scraper (`scripts/lib/historical-crawl/parsers/japanet.ts`) yields no per-product `source_url` because that site uses JS form-POST navigation. Adding image support requires re-engineering the parser to capture URLs, which is a different, larger change. Out of scope.
- **Image archival to our own storage** — we link to the upstream image host directly. If a host rotates/deletes an image we lose it; this matches the existing approach for QVC `thumbnail_url`. The video-archive S3 pipeline is precedent for *eventually* doing archival, but that's a separate PoC.
- **Image transforms / Next.js Image Optimization** — adding 7 new hosts to `next.config.ts::remotePatterns` is fragile and `next/image` adds complexity. The OA list item uses plain `<img>` with CSS-driven sizing; small thumbnails (~5KB each, browser-cached) at a known render size.
- **JSON-LD or other metadata fields** — ntv and dinos expose richer Schema.org `Product` (brand, description, price). Only `image` is captured here. Other fields can be added later if useful.
- **Image validation (HEAD-request to verify 200)** — we trust the upstream URL. Broken links degrade gracefully (browser shows alt text); too rare to invest in proactive checking.
- **Replacing existing thumbnail rendering for QVC/ShopCh** — they use the `broadcasts.thumbnail_url` field in a separate component (`BroadcastListItem.tsx`); unaffected.

## 3. Discovered Extraction Strategies (verified 2026-05-21)

| Channel | Method | Source | Sample image URL |
|---|---|---|---|
| **txd** | Use existing API response | `PictureCollection.URL[0]` already returned by `SearchWithBroadcastDate` | `https://www.tv-tokyoshop.jp/images/item/4292001.jpg` |
| **junsanpo** | Static HTML `og:image` | `<meta property="og:image" content="…">` on `ropping.jp/product/{id}` | `https://ropping.jp/data/image/product/scenario/000011/…/111643_002_01_IRhDpAxH.jpg` |
| **tbs** | Static HTML `og:image` | `shopping.tbs.co.jp/tbs/product/{id}` | `https://shopping.tbs.co.jp/product_image/scenario/…/main_01_aAGR5U50.jpg` |
| **senobura** | Static HTML `og:image` | `shop.asahi.co.jp/item/{id}.html` | `https://shop.asahi.co.jp/client_info/ABCMC/itemimage/G0032142A/G0032142A_s01.jpg` |
| **uranoura** | Static HTML `og:image` | `shop.asahi.co.jp/category/URANADJA/{id}.html` (same template as senobura) | `https://shop.asahi.co.jp/client_info/ABCMC/itemimage/Z0032459/Z0032459_1.jpg` |
| **dinos** | Static HTML `og:image` (+ JSON-LD `Product.image` as redundant source) | `www.dinos.co.jp/p/{id}/` | `https://www.dinos.co.jp/defaultMall/images/goods/TAA/2605/etc/T61411c1.jpg` |
| **ntv** | JSON API | `GET https://shop.ntv.co.jp/api/v1/item/detail-list/json?bics={id}&ptn=p0` → `itemListInfoXML.itL[0].itD.item.mainImgList[0].imgInfo.path` | `https://img.shop.ntv.co.jp/img/item/5003a/5003a4010006/5003a4010006_l1_a015.jpg` |

`source_url` Gcode / item id for ntv must be extracted from the existing `source_url` query string. For other channels the `source_url` is fetched directly.

All URLs verified to be absolute HTTPS. All extraction paths verified without authentication.

Recon performed via Playwright MCP (browser DevTools Network panel) for ntv/dinos; via curl + grep for the four `og:image` channels.

## 4. Database Migration

Single ALTER:

```sql
ALTER TABLE historical_broadcasts ADD COLUMN image_url text;
```

- Nullable. No default. No index.
- No backfill in the migration itself — script-driven, separate concern.
- Forward-compatible: existing readers ignore the new column.
- File: `supabase/migrations/2026-05-21_historical_broadcasts_image_url.sql`.

RLS: existing policies cover the new column (column-level RLS not used in this project).

## 5. Code Structure

```
lib/historical-crawl/
├── image-extractors/
│   ├── types.ts                      — interface ImageExtractor { extract(sourceUrl): Promise<string|null> }
│   ├── og-image.ts                   — cheerio extract for any page with <meta property="og:image">
│   ├── ntv-api.ts                    — JSON fetch + path navigation
│   └── index.ts                      — Record<OAChannelSlug, ImageExtractor | null>; null = unsupported
├── parsers/
│   ├── txd.ts                        — modified: PictureCollection.URL[0] → image_url
│   ├── junsanpo.ts, ntv.ts, tbs.ts, dinos.ts, senobura.ts, uranoura.ts
│   │                                 — each modified: after producing rows, call extractor for each row in parallel, fill image_url, swallow per-row errors
│   └── japanet.ts                    — no change (image_url stays null)
├── persist.ts                        — no change (just add image_url to upserted column set)
└── types.ts                          — HistoricalRow gains `image_url: string | null`
```

`image-extractors/og-image.ts` and `image-extractors/ntv-api.ts` are the only two extractor implementations. The 5 og-image channels (junsanpo, tbs, dinos, senobura, uranoura) share the single `og-image.ts` impl. ntv has its own because it's a JSON API not an HTML page.

Why this layout: parsers stay focused on schedule data; image enrichment is a cross-cutting concern with its own folder. Each extractor is independently testable (pure function over an HTML/JSON string).

## 6. Per-Channel Behavior

### 6.1 txd (zero-cost)

The existing `SearchWithBroadcastDate` list response includes `PictureCollection.URL[]` for every product. The parser already calls this; we just need to add one line to `txdProductToRow`:

```ts
image_url: p.PictureCollection?.URL?.[0] ?? null,
```

No additional HTTP fetches. Cron duration impact: 0.

### 6.2 og-image channels (junsanpo, tbs, senobura, uranoura, dinos)

For each row produced by the parser:

```ts
async function extract(sourceUrl: string): Promise<string | null> {
  const r = await politeFetch(sourceUrl);  // 20s timeout, no retry on 4xx
  if (!r.ok || !r.body) return null;
  const $ = cheerio.load(r.body);
  const og = $('meta[property="og:image"]').attr('content')?.trim();
  if (!og) return null;
  try { return new URL(og, sourceUrl).toString(); }  // defensive: handle relative
  catch { return null; }
}
```

Parser change pattern:

```ts
fetchToday: async (jstDate) => {
  // ...existing fetch + parse to produce rows...
  await mapWithConcurrency(rows, 5, async (r) => {
    if (!r.source_url) return;
    r.image_url = await ogImageExtractor.extract(r.source_url).catch(() => null);
  });
  return rows;
}
```

Failures are silent — `image_url` stays null, parser still returns the row.

**Concurrency cap (politeness)**: A naive `Promise.all` over all rows would launch ~30 simultaneous requests to the upstream host. Mitigate with a per-channel concurrency cap of 5 (small util in `image-extractors/types.ts`):

```ts
async function mapWithConcurrency<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
```

**Shared-host caveat**: senobura and uranoura both live on `shop.asahi.co.jp`. With 5-concurrent per parser and both parsers running in `crawlAll`'s `Promise.allSettled`, the asahi host sees up to 10 simultaneous requests. Acceptable for a once-a-day cron burst; if rate-limiting appears in `historical_crawl_runs`, reduce the cap to 3.

### 6.3 ntv (JSON API)

```ts
async function extract(sourceUrl: string): Promise<string | null> {
  // sourceUrl: https://shop.ntv.co.jp/item/{id}?areaid=sptvshopping
  const m = sourceUrl.match(/\/item\/([a-z0-9]+)/i);
  if (!m) return null;
  const bics = m[1];
  const apiUrl = `https://shop.ntv.co.jp/api/v1/item/detail-list/json?bics=${encodeURIComponent(bics)}&ptn=p0`;
  const r = await politeFetch(apiUrl, { headers: { Accept: "application/json, text/plain, */*" } });
  if (!r.ok || !r.body) return null;
  try {
    const body = JSON.parse(r.body) as NtvApiResponse;
    return body.itemListInfoXML?.itL?.[0]?.itD?.item?.mainImgList?.[0]?.imgInfo?.path ?? null;
  } catch { return null; }
}
```

Parser change is identical to og-image — `Promise.all` + extractor call.

## 7. Daily Cron Integration (Forward — Option E)

No change to `app/api/cron/daily-historical-broadcasts/route.ts`. The parsers themselves now produce rows with `image_url` set; `persistRows` upserts them as before with the new column included.

### Expected cron duration impact

Current average: ~5 seconds total for all 7 parsers.

After change:

- txd: +0s (already in API response).
- 6 channels × avg ~35 new slots/day × ~800ms per og-image / ntv-api fetch.
- Concurrency cap 5 per channel.
- All channels still run in parallel via `Promise.allSettled` in `crawlAll`.
- Effective per-channel time ≈ ceil(slots / 5) × 800ms. For the worst-case channel (junsanpo ~125 slots/day), that's 25 × 800ms = 20s. Other channels finish faster and the whole `Promise.allSettled` returns when the slowest one does.

Total expected cron: 5s → ~25-35s. Well under the 300s `maxDuration`.

### `historical_crawl_runs` observability

The existing `channels[]` array already records `rowCount` and `durationMs` per channel. No schema change. Operators can spot regressions (rowCount drops, durationMs spikes) via `/admin/historical-crawl` as before.

A `null`-rate observation (rows where image_url stayed null) is a future enhancement — not needed for v1 since image failures don't gate the row write.

## 8. Backfill of Existing Rows (One-Shot — Option H)

`scripts/backfill-oa-images.ts` enriches existing rows where `image_url IS NULL` and `source_url IS NOT NULL`.

Invocation:

```
npx tsx --env-file=.env.local scripts/backfill-oa-images.ts --channel=ntv [--limit=N] [--throttle=350]
```

Per-row flow:

1. SELECT id, source_url FROM historical_broadcasts WHERE channel = $1 AND image_url IS NULL AND source_url IS NOT NULL ORDER BY air_date DESC LIMIT $limit
2. For each row (sequential with throttle, OR parallel-N within one channel): call extractor → UPDATE WHERE id = $rowId
3. Print progress every 50 rows.
4. Idempotent: stopped runs resume cleanly because the SELECT keeps returning NULL rows.

Channel-scoped intentionally so the operator can parallelize across terminals (each channel hits a different host).

### txd special case

txd's image lives in the list-API response, not at a product detail URL. Two options for the backfill:

- **Option A (chosen)**: Add `--channel=txd` to the same script, which re-fetches the list API for each unique `air_date` and updates rows by `(channel, air_date, product_name)` matching. Reuses `txdParser.fetchToday(date)` directly — same code path as the original `backfill-txd.ts`, just writes image_url too.
- **Option B (rejected)**: Fetch detail page per product. Slower and the data isn't easily available there.

In practice the operator can keep using the existing `scripts/backfill-txd.ts` after a 1-line patch (already calls `txdParser.fetchToday`; once the parser emits `image_url`, re-running the backfill fills it via the UPSERT path). The new `scripts/backfill-oa-images.ts` is only for the 6 channels that need per-source_url fetch.

### Estimated runtime

| Channel | NULL rows | Time (350ms throttle, sequential) | Time (parallel 4 workers) |
|---|---|---|---|
| junsanpo | ~4,167 | ~25 min | ~7 min |
| tbs | ~3,321 | ~20 min | ~5 min |
| dinos | ~2,251 | ~15 min | ~4 min |
| senobura | ~2,969 | ~20 min | ~5 min |
| uranoura | ~385 | ~3 min | ~1 min |
| ntv | ~2,490 | ~15 min | ~4 min |
| **6 channels total (sequential)** | ~15,583 | ~98 min | — |
| **6 channels parallel** (one terminal per channel) | — | ~25 min wall time | — |
| txd (via existing backfill-txd.ts re-run) | ~9,018 | ~30 min | — |

Realistic operator approach: launch 6 backfill jobs in parallel terminals + 1 txd re-run = ~30 min wall time total.

## 9. UI Changes

### 9.1 `lib/components/broadcasts/OABroadcastListItem.tsx`

Add to `OARow` interface:

```ts
image_url: string | null;
```

Insert thumbnail before the time column:

```tsx
{row.image_url ? (
  <img
    src={row.image_url}
    alt=""  // decorative; product name is in the adjacent text
    className="shrink-0 w-12 h-12 object-cover rounded border border-gray-100"
    loading="lazy"
    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
  />
) : (
  <div className="shrink-0 w-12 h-12 rounded bg-gray-50 border border-gray-100" aria-hidden="true" />
)}
```

Placeholder div for rows without `image_url` keeps row heights visually aligned (japanet rows and fetch-failed rows render uniformly with the imaged rows).

`onError` hides broken image silently (e.g., if upstream rotates a URL).

### 9.2 `app/api/historical-broadcasts/route.ts`

Add `image_url` to the SELECT column list and to the `HistoricalBroadcastRow` interface. No other change.

### 9.3 No change to `next.config.ts`

We use plain `<img>`, not `next/image`. Adding 7 hosts to `remotePatterns` is avoided.

## 10. Tests

| Layer | Test | File |
|---|---|---|
| og-image extractor | parses fixture HTMLs from 5 channels (one per channel), returns absolute URL or null | `scripts/test-og-image-extractor.ts` + `scripts/fixtures/oa-images/{channel}-{date}.html` |
| ntv-api extractor | parses fixture JSON, returns mainImgList path | `scripts/test-ntv-image-extractor.ts` + `scripts/fixtures/oa-images/ntv-api-{id}.json` |
| txd parser | existing fixture test gains `image_url` assertion | `scripts/test-historical-txd-parser.ts` (modify) |
| Live integration | one live call per channel returns ≥1 row with non-null `image_url` | `scripts/test-oa-images-live.ts` |

No new npm scripts beyond what's already needed; bespoke scripts following the project's existing pattern.

## 11. Migration & Rollout Order

1. Migration first (`ALTER TABLE ADD COLUMN`).
2. Code changes (extractors, parsers, types, API, UI).
3. Deploy.
4. Daily cron starts populating `image_url` for new rows automatically at next JST 01:30.
5. Operator runs backfill at convenient time (one channel at a time or parallel, ~25-30 min wall time).
6. UI shows images as data lands.

Each step is independently reversible. UI degrades gracefully if `image_url` is null.

## 12. Error Handling

| Failure mode | Behavior |
|---|---|
| Image extractor HTTP 4xx/5xx | Returns null. Row still saved with `image_url: null`. |
| Image extractor timeout (20s `politeFetch` default) | Returns null. |
| Image extractor parse error (missing meta tag, malformed JSON) | Returns null. |
| Upstream site DOM/API changes | Extractor returns null for all rows of that channel — operators see `null_rate` jumping in admin dashboard (future enhancement) or notice missing thumbnails in UI. Recovery: update extractor selector. |
| Browser image load fails (broken URL) | `onError` hides the `<img>`; the placeholder div is not re-shown (intentional: clutter-avoidance — extreme edge case). |
| Backfill mid-run interrupt | Resume by re-running same command; idempotent via `image_url IS NULL` filter. |
| Backfill rate limit (HTTP 429) | `politeFetch` returns the 4xx without retry; extractor returns null; row's `image_url` stays NULL; next backfill run retries. If rate-limiting is recurring, operator lowers `--throttle`. |

## 13. Risks

1. **`og:image` may be a generic placeholder** (site logo, not product). Mitigation: fixture-based tests inspect actual values; if observed, add per-channel regex/path validation in the extractor.
2. **ntv API stability** — the `/api/v1/item/detail-list/json` endpoint is public but undocumented. Rotation/deprecation breaks ntv image enrichment. Mitigation: failure is observable (null rate) and recoverable (extractor swap to og:image-equivalent if dinos approach works there too, which it probably doesn't given ntv is SPA).
3. **Backfill operator footgun**: forgetting `--channel` argument would attempt all-channel run sequentially (~98 min) without parallelism. Mitigation: script REQUIRES `--channel`; no default.
4. **`next/image` not used** — accessibility audit may flag missing image dimensions. Mitigation: CSS-set 48×48 is intrinsic via class; reserve_layout is fine. If lighthouse complains, add explicit `width`/`height` attrs.

## 14. Success Criteria

- After deploy + next JST 01:30 cron, new rows in `historical_broadcasts` for the 7 supported channels have non-null `image_url`.
- After operator backfill, existing rows have ≥80% `image_url` coverage per channel (some genuinely broken URLs allowed).
- Calendar `UnifiedDayDetailPanel` shows thumbnails next to OA rows for the 7 channels; japanet rows show placeholder div (intentional, current state preserved).
- No regression in QVC/ShopCh rendering (separate component).
- Cron duration stays under 60s on typical day; alerts not triggered.

## 15. Open Questions

None at design time. Implementation plan will surface specifics (e.g., precise extractor signatures, fixture HTML retrieval method, parallelism caps).

## 16. Future Work (out of scope)

- `japanet` image support — requires re-engineering the parser to capture per-product URLs (currently uses JS form-POST navigation that yields no GET URL).
- Image storage archival to AWS S3 (precedent: QVC video archive) — gives durability against upstream rotation.
- `next/image` adoption — requires `remotePatterns` enumeration and per-host CDN testing.
- Richer Schema.org Product fields (brand, description, price) for ntv/dinos via JSON-LD.
- `null_rate` observability dashboard (channel-wise image_url coverage trend).
