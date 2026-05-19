# Competitive Snapshot Archival — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-05-19
**Scope**: Capture and permanently archive what competitor home-shopping channels (QVC, ShopCh) air — both the broadcast video itself and a point-in-time snapshot of every product shown — so the operator can answer "what is selling well at competitors" weeks or months after the live broadcast has been removed from the source site.

---

## 1. Goal

The platform already records that QVC and ShopCh aired program X on date Y at time Z (`broadcasts` table). Today, almost everything else gets thrown away after the daily scrape: the actual video, per-product pricing/discount/stock state, brand attribution, and product images. The source sites delete this information within ~30 days (ShopCh JSON 403s for older programs; QVC product pages keep shifting under us).

This spec turns the existing scrape pipeline into a competitive-intelligence archive:

1. **For every whitelist-matching slot, capture a row-per-product snapshot** at scrape time — name, image, price (current + original), discount label, in-stock status, brand. Snapshots are append-only and timestamped, so price/availability changes over multiple re-airings can be tracked.
2. **Download the broadcast video** to Cloudflare R2 in MP4 form, indexed by (channel, air_date, start_time). The video plus its product snapshot is enough to reconstruct "what was sold and how it was pitched" even after the source site removes the content.
3. **Surface both in the existing calendar UI** — a ▶ button on each archived slot opens a video modal with the per-product snapshot list underneath.

The user does not have to remember to flag interesting slots; the daily cron archives every whitelist-matching slot automatically.

## 2. Non-Goals (YAGNI)

- **ShopCh video archival**: the m3u8 hosts return HTTP 403 to anonymous public requests. Resolving that requires a separate Playwright PoC for authentication/Referer behavior. This spec defers ShopCh video; metadata snapshot still happens for ShopCh.
- **Video transcoding / re-encoding**: we copy m3u8 segments into an MP4 container (`ffmpeg -c copy`), no re-encode. Quality matches the source. CPU stays near zero.
- **Transcription / AI summarization of video**: separate future spec. Storage is the prerequisite.
- **Auto-deletion lifecycle / cold tiering**: R2 storage cost is ~$5/month at first-year scale. No automated deletion. Manual retention policy can be added later.
- **Search/discovery UI over snapshots**: this spec ships data; a dedicated "what's airing repeatedly" or "discount intensity over time" dashboard is a separate spec consuming `broadcast_products`.
- **`broadcast_products` for non-whitelist categories**: only whitelist-matching slots get snapshotted. Non-whitelist slots stay metadata-only on `broadcasts`.
- **OA channel videos** (the 7 channels in `historical_broadcasts`): scope creep. Same reasoning as ShopCh video — separate PoC if/when needed.

## 3. Data Sources

| Source | Used for | Notes |
|---|---|---|
| `broadcasts` table | Slot identity (channel, air_date, start_time), category whitelist gate | Already exists. Read-only here. |
| `qvc_products` table | QVC per-product detail snapshot source: name, price, image, video_url | Already populated by `enrich:qvc-products` cron. This spec adds 3 columns (brand, original_price_jpy, sale_label) parsed from existing scrape. |
| ShopCh JSON `/json/programprodlist2/{id}.json` `prodList1[]` | ShopCh per-product detail snapshot source — name, image, current/original price, discount rate, sale label, tax-inclusion, stock | Already fetched per-slot for category. We extract more fields. |
| QVC `og:video` meta on product page | QVC video URL (m3u8) | Already in `qvc_products.video_url`. Cloudfront-hosted, anonymous-readable. HEAD-verified. |
| ShopCh `pgmMovie` JSON field | ShopCh video URL stem | Stem only; full host gated (403). Deferred. |

Service-role Supabase access is used because all writes happen from cron paths (`/api/cron/*`). RLS on the new table is Group A (member-readable, admin-writable) — the snapshot data is competitor research, member-visible per existing auth tiers.

## 4. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Daily Cron — JST 01:00 (existing)                       │
│  app/api/cron/daily-broadcasts/route.ts                  │
│                                                           │
│  1. scrape QVC + ShopCh (existing)                       │
│  2. upsert broadcasts (existing)                         │
│  3. NEW: for whitelist-match slots:                      │
│       enrich brand_name/brand_code                       │
│       upsert broadcast_products (one row per product)    │
│       set video_status='queued'                          │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│  Video Archival Worker — JST 04:00 + 10:00 (NEW)         │
│  app/api/cron/archive-videos/route.ts                    │
│                                                           │
│  WHERE video_status='queued' AND attempts < 5            │
│  ORDER BY air_date DESC LIMIT 8                          │
│                                                           │
│  per slot (concurrency 4):                               │
│    resolveVideoUrl()                                     │
│    ffmpeg -c copy → R2 multipart upload (stream)         │
│    UPDATE archived_video_s3, size, duration, status      │
└──────────────────────────────────────────────────────────┘

UI:
  components/broadcasts/BroadcastListItem.tsx
    └─ ▶ icon when archived_video_s3 IS NOT NULL
    └─ click → BroadcastVideoModal (new)
         ├─ HTML5 <video> playing R2-hosted MP4
         └─ broadcast_products list (price/discount/stock/image)

  app/[locale]/(admin)/admin/archive-status/page.tsx (new)
    └─ video_status counts, recent failures, force-retry button
```

**Two cron passes are intentional**: 04:00 catches yesterday's slots after live programming ends (so streams are stable); 10:00 retries anything 04:00 missed. Eight slots per pass × four parallel ffmpeg pipes × ~30 s wall time ≈ 240 s — comfortably inside the 300 s Function timeout.

The architecture deliberately splits metadata snapshot (fast, sync, transactional with scrape) from video archival (slow, async, retry-tolerant). A scrape never blocks on ffmpeg, and a failed video download never corrupts the snapshot data.

## 5. Schema Changes

### 5A. `broadcasts` — two added columns

```sql
ALTER TABLE broadcasts
  ADD COLUMN brand_name text,
  ADD COLUMN brand_code text;
```

`brand_name` comes from QVC JSON-LD `brand` or ShopCh JSON `brandname`. `brand_code` is ShopCh's `brandcode` (QVC has no equivalent code; null is acceptable).

### 5B. `qvc_products` — three added columns

```sql
ALTER TABLE qvc_products
  ADD COLUMN brand text,
  ADD COLUMN original_price_jpy int,    -- list price before discount
  ADD COLUMN sale_label text;           -- "WSV", promo type, etc.
```

These are parsed from the existing product-page HTML (JSON-LD `brand`, inline `utag_data` block) — no extra HTTP calls. Existing rows get backfilled by re-running the enrich script with the updated parser.

### 5C. `broadcast_products` — new table

Append-only per-slot product snapshot. Same `product_id` reappearing in a later slot writes a new row keyed by the new `broadcast_id`.

```sql
CREATE TABLE broadcast_products (
  broadcast_id        uuid        NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  product_id          text        NOT NULL,            -- QVC product id or ShopCh reqPrNo
  position            int         NOT NULL,            -- 0-based order within the slot's product list
  name                text,
  image_url           text,
  price_jpy           int,                              -- current (sale) price
  original_price_jpy  int,                              -- list price; null when no discount displayed
  discount_rate       int,                              -- 0–100; null when not emitted
  sale_label          text,                             -- e.g. "期間限定:5/18〜24", "%OFF", "WSV"
  tax_incl            boolean,                          -- texStr === '(税込)' for ShopCh
  in_stock_at_capture boolean,                          -- false if availability='OutOfStock' or nostockName
  source              text        NOT NULL,             -- 'qvc' | 'shopch'
  captured_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (broadcast_id, product_id)
);

CREATE INDEX broadcast_products_product_idx   ON broadcast_products (product_id);
CREATE INDEX broadcast_products_captured_idx  ON broadcast_products (captured_at DESC);

-- RLS: Group A — member-readable, admin-writable
ALTER TABLE broadcast_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY broadcast_products_read  ON broadcast_products FOR SELECT TO authenticated USING (true);
CREATE POLICY broadcast_products_write ON broadcast_products FOR ALL    TO service_role USING (true);
```

Migration file: `supabase/migrations/2026-05-19_broadcast_products_and_brand.sql`.

## 6. Pipeline Detail

### 6A. Snapshot Enrichment (inside `app/api/cron/daily-broadcasts/route.ts`)

After existing `upsertSlots`, walk the slots that were inserted or updated. For each slot whose `category` is in `channel_categories.is_allowed = true` for its channel:

**QVC path**:
1. `SELECT id, name, image_url, price_text, brand, original_price_jpy, sale_label, video_url FROM qvc_products WHERE id = ANY(slot.product_ids)`.
2. Parse `price_text` (yen with comma) → `price_jpy int`.
3. For each id present in `product_ids` (in array order), insert a `broadcast_products` row with `position = idx`. Missing qvc_products rows (not yet enriched) → row gets name=null/etc., still inserted so `position` order is preserved and a later catch-up backfill can fill them.
4. From the first present row whose `brand` is non-null, copy it → `broadcasts.brand_name`. If every resolved product has `brand` null, leave the column null. QVC has no brand code, so `brand_code` stays null regardless.
5. `UPDATE broadcasts SET video_status = 'queued'` for slots that resolved at least one product with a `video_url`.

**ShopCh path**:
1. `fetchShopChSlotMetadata(programId)` (already extended in this spec — see Section 6C) returns full `products[]`.
2. Insert one row per `products[i]` into `broadcast_products`, mapping `genzaiPrice`→`price_jpy`, `comperPrice`→`original_price_jpy`, `offRate`→`discount_rate`, `limitedPriceLabel`→`sale_label`, `texStr==='(税込)'`→`tax_incl`, `nostockName === ''`→`in_stock_at_capture=true`.
3. `UPDATE broadcasts SET brand_name = meta.brandName, brand_code = meta.brandCode`.
4. `video_status = 'failed_unsupported'` (ShopCh video deferred — Section 9).

Both paths are wrapped in a single Supabase `.upsert` with `onConflict: 'broadcast_id,product_id'` so re-runs are idempotent. Re-runs do **not** create new snapshot rows for the same broadcast — the snapshot represents that broadcast's content, and one upsert per re-run is fine because broadcasts are immutable (a re-air is a different `broadcast_id`).

### 6B. Video Archival Worker (`app/api/cron/archive-videos/route.ts`)

Cron-triggered HTTP route, internal-auth gated via `hasInternalSecret(req)`:

```ts
export async function GET(req: NextRequest) {
  if (!hasInternalSecret(req)) return new Response('unauthorized', { status: 401 });

  const sb = getServiceClient();
  const { data: queue } = await sb.from('broadcasts')
    .select('id, channel, product_ids, air_date, start_time')
    .eq('video_status', 'queued')
    .lt('video_download_attempts', 5)
    .order('air_date', { ascending: false })
    .limit(8);

  const results = await pMap(queue ?? [], archiveOne, { concurrency: 4 });
  return NextResponse.json({ processed: results.length, ...summarize(results) });
}
```

`archiveOne(slot)`:
1. `UPDATE video_status='downloading'` (claim the slot — another concurrent cron run won't pick it up).
2. `resolveVideoUrl(slot)` — QVC: lookup `qvc_products.video_url` for `slot.product_ids[0]`. ShopCh: `null` (handled by `failed_unsupported` mark before this point, defensive double-check).
3. If url is null → `video_status='deferred'`, `video_error='no video_url for first product'`. Next daily-broadcasts cron resets to queued after enrich. Return.
4. `ffmpegStreamToR2(m3u8Url, key)`:
   - Spawn `ffmpeg -i {m3u8} -c copy -f mp4 pipe:1` (use `@ffmpeg-installer/ffmpeg`).
   - Pipe stdout to `@aws-sdk/lib-storage::Upload` (multipart, automatic retries, R2 endpoint).
   - Capture ffmpeg stderr; parse final `Duration: HH:MM:SS.xx` for `video_duration_sec`.
   - Resolve when upload completes; `Upload` returns `Location` and bytes-uploaded.
5. `UPDATE` archived_video_s3 (the R2 key, not full URL), video_size_bytes, video_duration_sec, video_quality='source', video_status='archived', video_downloaded_at=now().
6. On any throw: increment `video_download_attempts`, set `video_status='queued'` (back to queue), store `video_error` (first 500 chars of stderr or exception message). At attempts >= 5 final state becomes `video_status='abandoned'`.

**R2 key convention**:
```
videos/{channel}/{air_date}/{start_time}--{broadcast_id_short_8}.mp4
```
Deterministic — same slot re-archived overwrites the same R2 object.

**ffmpeg binary**: `@ffmpeg-installer/ffmpeg` (~50 MB npm dependency, bundles the binary). Vercel Functions Fluid Compute supports the resulting layer; Node 24 runtime confirmed via repo's existing `vercel.json` settings.

### 6C. Parser Extensions

**`lib/qvc-products/fetcher.ts`** — add to `parseQvcProductHTML`:

- Extract JSON-LD `brand` field (the existing parser already loads JSON-LD nodes for category — reuse).
- Parse inline `var utag_data = { ... }` block for `product_qvc_price` (list price) and `special_price_code` (sale label). Single regex over the matched script body.
- Returned interface gets three new fields: `brand`, `originalPriceJpy`, `saleLabel`. The enrich path writes them to the new `qvc_products` columns.

**`lib/broadcasts/shopch-json.ts`** — extend `ShopChSlotMetadata`:

```ts
export interface ShopChProductSnapshot {
  productId: string;          // reqPrNo
  name: string | null;
  imageUrl: string | null;    // absolute from prodImg
  priceJpy: number | null;    // genzaiPrice parsed (commas stripped)
  originalPriceJpy: number | null;  // comperPrice
  discountRate: number | null;      // offRate (already 0-100 integer string)
  saleLabel: string | null;         // limitedPriceLabel or saleStr
  taxIncl: boolean | null;          // texStr === '(税込)'
  inStockAtCapture: boolean;        // nostockName is empty/missing
}

export interface ShopChSlotMetadata {
  category: string | null;
  categoryCode: string | null;
  productIds: string[];
  products: ShopChProductSnapshot[];  // NEW — full per-product detail
  brandName: string | null;
  brandCode: string | null;
}
```

The existing `parseShopChSlotJSON` already walks `prodList1`; extend the loop to fill the new structure. Pure parser, no I/O change. Existing tests stay green.

## 7. Storage Backend — Cloudflare R2

- **Bucket**: `mediaworks-broadcasts` (one bucket; subdirectories distinguish `videos/`, `thumbnails/`).
- **Access**: R2 S3-compatible endpoint via AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/lib-storage`). The SDK works with R2 by setting `endpoint`, `forcePathStyle: true`, and `region: 'auto'`.
- **Public read**: configured via R2 custom domain or `pub-*.r2.dev` URL (whichever the operator prefers). `broadcasts.archived_video_s3` stores the **key**, not the full URL; the UI composes `${R2_PUBLIC_BASE_URL}/${key}` at render time.
- **Env vars** (Vercel project + `.env.local`):
  - `R2_ACCOUNT_ID`
  - `R2_ACCESS_KEY_ID`
  - `R2_SECRET_ACCESS_KEY`
  - `R2_BUCKET=mediaworks-broadcasts`
  - `R2_PUBLIC_BASE_URL` (e.g. `https://archive.mediaw-b.com` or `https://pub-{hash}.r2.dev`)

**Why R2 over alternatives** is reasoned in Section 2C of brainstorm transcript; the short version: zero egress cost matters because video playback is an expected workflow ("MD watches the archived broadcast"), and Supabase/S3 charge $0.09/GB egress.

## 8. Error Handling & Retry

| Failure | Visible state | Recovery |
|---|---|---|
| m3u8 fetch returns 5xx / timeout | `video_status='queued'`, attempts++, `video_error` set | Next archive-videos cron run retries |
| ffmpeg crash mid-stream | same | same |
| R2 upload network error | same — `Upload` retries internally up to 3× before throwing | same |
| `qvc_products.video_url` is null (product not enriched yet) | `video_status='deferred'` | Daily cron re-marks `queued` after the next `enrich:qvc-products` run fills the row |
| 5 attempts reached | `video_status='abandoned'` | Admin sees it on `/admin/archive-status`; manual force-retry resets attempts to 0 |
| ShopCh slot (no video pipeline yet) | `video_status='failed_unsupported'` set at snapshot enrichment time | Wait for ShopCh PoC (Section 9) |

`video_status` enum values:
```
pending           — schema default; no enrichment yet
queued            — snapshotted; awaiting archival worker
downloading       — claimed by a worker run (concurrency guard)
archived          — terminal success
deferred          — waiting on a precondition (qvc_products enrich)
failed_unsupported — channel doesn't support video archival yet (ShopCh today)
abandoned         — exceeded retry budget; admin intervention required
```

The transitions are encoded as a table-internal state machine; no separate `video_state_history` table (a single `video_status + video_download_attempts + video_error + video_downloaded_at` quartet is sufficient for ops needs).

## 9. UI Integration

### 9A. Calendar slot — `components/broadcasts/BroadcastListItem.tsx`

Conditional ▶ button:

```tsx
{broadcast.archived_video_s3 && (
  <button onClick={() => openModal(broadcast)} aria-label={t('playArchive')}>
    <PlayIcon size={14} />
  </button>
)}
{broadcast.video_status === 'queued' || broadcast.video_status === 'downloading' && (
  <Loader2 size={14} className="animate-spin text-gray-400" />
)}
```

ShopCh slots (`failed_unsupported`) show no icon — clean, no broken-state noise.

### 9B. Video modal — `components/broadcasts/BroadcastVideoModal.tsx` (NEW)

- Top: HTML5 `<video controls preload="metadata" src={R2_PUBLIC_BASE_URL + '/' + key}>`. MP4 source supports native playback in Safari/Chrome/Firefox; no hls.js required because we serve MP4 (transcoded by ffmpeg copy).
- Below the video: vertical list of `broadcast_products` for that `broadcast_id`, ordered by `position`. Each card: image · name · price (¥X,XXX (税込)) · `[discount badge if discount_rate]` · `[完売 badge if !in_stock_at_capture]` · `[brand_name]`.
- Loaded via `/api/broadcasts/{id}/products` (new read endpoint, member-gated, joins `broadcast_products`).

### 9C. Admin archive status — `app/[locale]/(admin)/admin/archive-status/page.tsx` (NEW)

- Counts by `video_status` (queued / downloading / archived / deferred / failed_unsupported / abandoned).
- Table of latest 50 failures: broadcast_id, channel, air_date, attempts, video_error excerpt, "force retry" button (POST `/api/admin/broadcasts/{id}/retry-archive` → reset attempts to 0, status to 'queued').
- Total bytes archived, R2 cost estimate (computed locally from size_bytes sum × $0.015).

## 10. Migration & Backfill Sequence

1. **Apply migration** (`2026-05-19_broadcast_products_and_brand.sql`) — adds columns + table + RLS. Zero-downtime.
2. **Deploy parser changes** — qvc fetcher + shopch-json fetcher get the new fields. No DB effect on its own.
3. **Re-enrich qvc_products** with the new parser (`npm run enrich:qvc-products -- --stale=0`) — populates `brand`, `original_price_jpy`, `sale_label` for ~2000 rows. Reuses existing politeFetch + concurrency limits. ~10 minutes.
4. **Backfill `broadcast_products`** with `scripts/backfill-broadcast-products-2026-05-19.ts`:
   - QVC: SELECT whitelist-matching broadcasts (~370 in stored history), expand `product_ids[]` × LEFT JOIN qvc_products → INSERT rows. Pure DB join, ~1 minute.
   - ShopCh: walk whitelist-matching broadcasts (~354), refetch JSON for each (newer 30 days reachable, ~30 sec), INSERT rows from extended `parseShopChSlotJSON.products[]`.
   - After insert, `UPDATE broadcasts SET video_status='queued'` for QVC matches (only those with a resolved video_url); `'failed_unsupported'` for ShopCh.
5. **Manual archival smoke** — trigger archive-videos cron once with auth header from the CLI (`curl -H "x-internal-secret: ..." https://.../api/cron/archive-videos`). Expect 8 slots processed, all `archived`. Verify in R2 dashboard + `/admin/archive-status`.
6. **Register cron** in `vercel.json` for 04:00 + 10:00 JST. Function timeout 300 s, memory 1024 MB.
7. **UI PR (independent)** — modal + admin page can ship a day or two after the data pipeline is healthy.

Total backlog (~370 QVC slots ÷ 8 per cron run × 2 cron runs per day) drains in ~24 days. Live daily flow (30–50 new whitelist slots per day) is absorbed by the same cadence indefinitely.

## 11. Testing

| Layer | Approach | File |
|---|---|---|
| QVC fetcher JSON-LD brand extraction | Fixture-based unit | `lib/qvc-products/__tests__/fetcher.test.ts` (NEW) |
| QVC fetcher utag_data discount extraction | Fixture-based unit | same |
| ShopCh JSON parser `products[]` mapping | Fixture-based unit | `lib/broadcasts/__tests__/shopch-json.test.ts` (extend) |
| Snapshot enrichment in daily-broadcasts | Mock Supabase + mock fetchers; assert `broadcast_products` row shape | `lib/broadcasts/__tests__/snapshot-enrichment.test.ts` (NEW) |
| Archive worker happy path | Mock ffmpeg spawn returning a fixture stream; mock R2 SDK | `app/api/cron/archive-videos/__tests__/route.test.ts` (NEW) |
| Archive worker retry / abandon transitions | DB-level transitions tested without invoking ffmpeg | same |
| ffmpeg end-to-end | One-off `scripts/smoke-archive-one.ts` — archives a real ~30 sec test m3u8 to a dev R2 bucket, asserts MP4 plays | smoke, not CI |

The fixture-based parser tests follow the existing `npm run test:broadcasts-parsers` pattern (HTML/JSON checked-in under `lib/.../__tests__/fixtures/`).

## 12. Observability

- **Per-cron structured log**: `{ cron: 'archive-videos', date, processed, archived, deferred, failed, total_bytes }` emitted as a single JSON line. Surfaces in Vercel logs.
- **Daily admin dashboard widget** on `/admin/archive-status`:
  - Status histogram for last 30 days
  - 24h delta: archived vs queued (should be ≈ same on healthy days)
  - Top 5 video_error messages by frequency (catches systemic parser/ffmpeg breakage)
- **Manual alerting (deferred)**: if `archived count < expected for 3 days in a row`, emit a `gh issue create` from the cron itself. Considered nice-to-have, not in v1.

## 13. Future Work

The following are explicit follow-ups, sequenced by dependency:

1. **ShopCh video PoC**: Playwright session against the ShopCh web player to capture the m3u8 request's Referer/Cookie/Auth header. If successful, the existing archive worker gains a `resolveShopChVideoUrl(slot)` branch; no other code changes. Spec: separate.
2. **OA channel snapshots (historical_broadcasts)**: extend `broadcast_products` to also reference historical_broadcasts rows. The 7 OA channels have varying detail availability; spec separately when whitelist work for those channels finishes.
3. **Discovery integration**: a candidate matching multiple `broadcast_products` rows over time gets a boost in `discovery/competitor-trend-boost.ts`. Today the boost uses `broadcasts.category` only — adding per-product matches sharpens the signal.
4. **Replay search UI**: surface a "what's been airing repeatedly?" view that ranks `broadcast_products` by `count(product_id) over last_30_days`, with a sparkline of price changes per product.
5. **Gemini transcription of archived video** for searchable script corpus (depends on storage being durable).
6. **R2 lifecycle policy**: auto-tier to Glacier-equivalent or auto-delete after N years. Not pressing at $5/month.

---

End of design.
