# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI-powered home shopping product research platform. Users upload product files (PDF, PPTX, DOCX, images), the system extracts product info via Gemini Vision API, then synthesizes comprehensive market research reports targeting Japan and Korea markets.

## Commands

```bash
npm run dev      # Start dev server (localhost:3000)
npm run build    # Production build
npm run lint     # ESLint
```

No test framework is configured.

## Architecture

### Two-Phase Async Processing Pipeline

1. **Extract** (`POST /api/analyze`): Gemini Vision extracts product metadata from uploaded files → returns immediately
2. **Synthesize** (`POST /api/analyze/synthesize`): Triggered in background by extract phase → runs Brave Search + Rakuten API queries → Gemini synthesizes a 13-section research report → saves to Supabase

### Key Data Flow

```
File Upload → Supabase Storage → Gemini Vision (extract)
  → Brave Search + Rakuten (parallel queries) → Gemini (synthesize)
  → Supabase DB (research_results) → Report UI (13 sections)
```

### Route Structure

- `app/[locale]/` — i18n routing (en, ja; default: ja) via next-intl
- `app/[locale]/page.tsx` — Home: file upload tab + AI recommend tab
- `app/[locale]/products/[id]/page.tsx` — Full research report with PDF export
- `app/api/` — All API routes (analyze, synthesize, recommend, upload, products, cron)
- `proxy.ts` — next-intl middleware (locale routing, excludes /api and static files)

### External Services

| Service | Purpose | Env Var |
|---------|---------|---------|
| Supabase | PostgreSQL DB + file storage | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Google Gemini | Vision extraction + research synthesis (gemini-3.5-flash, fallback gemini-3.1-pro-preview) | `GEMINI_API_KEY` |
| Brave Search | Web research queries | `BRAVE_SEARCH_API_KEY` |
| Rakuten API | Japan market product ranking data | `RAKUTEN_APP_ID` |

### Broadcast Calendar (Phase A — read-only)

- Daily JST 01:00 cron (`16:00 UTC` → `app/api/cron/daily-broadcasts/route.ts`) scrapes yesterday's broadcasts from Shop Channel (`shopch.jp`) and QVC Japan (`qvc.jp`) via cheerio.
- Daily JST 02:00 cron (`17:00 UTC` → `app/api/cron/qvc-monthly-refresh/route.ts`) re-scrapes the QVC programme guide for the **previous month + current month** (Phase 1-B) via `lib/broadcasts/qvc-monthly.ts::refreshQVCMonthlyRange`. The QVC site exposes ~2 months of schedule data; this catches slots published ahead of time and corrects any backfill gaps. Upserts are idempotent (channel,air_date,start_time conflict key), so daily reruns are cheap.
- Read API: `GET /api/broadcasts?from=YYYY-MM-DD&to=YYYY-MM-DD[&channel=shopch|qvc]` (max 62-day range).
- Admin recovery: `POST /api/broadcasts/refresh` with `{date}` or `{from,to}` (max 7 days), `Bearer ${CRON_SECRET}`.
- UI: `/[locale]/broadcasts` — month grid + sticky right-side `UnifiedDayDetailPanel` (covers all 9 channels with schedule data: QVC, ShopCh, and 7 OA channels in one list with channel + category chip filters). Below the calendar, a separate `HistoricalBroadcasts` panel offers free-text history search across **all 9 channels** (QVC + ShopCh from `broadcasts` table, 7 OA from `historical_broadcasts`). `/api/broadcasts` accepts `?search=` (program_title ilike); the panel calls both endpoints in parallel and merges results client-side. No date coupling — empty until the user enters a search term or picks a channel chip. (btops was removed 2026-05-17 — site closed.)
- Module layout: `lib/broadcasts/{types,fetch,shopch,qvc,persist,index}.ts`.
- Fixture-based parser tests: `npm run test:broadcasts-parsers`. Live integration: `npm run test:broadcasts-live`. Operational diagnostic: `npm run verify:broadcasts`. One-shot 7-day backfill: `npm run backfill:broadcasts -- --days=7`.
- Phase B PoC (QVC only): `broadcasts.product_ids text[]` is populated from each slot's `data-products` attribute; `qvc_products` caches OG metadata (name, image, price text, video) fetched from `qvc.jp/product.{id}.html`. The daily cron auto-enriches new IDs; manual run via `npm run enrich:qvc-products`. Shop Channel product detail requires JS rendering (Playwright) and is deferred.
- Category whitelist (Phase 1-C, `lib/broadcasts/category-filter.ts` + `channel_categories` table): every QVC + ShopCh slot gets a `category`. QVC reads from `qvc_products.category` (extracted by the product-page parser via JSON-LD or breadcrumb); ShopCh runs a Gemini batch classifier on `program_title + description` against a 5-item whitelist. **Policy (2026-05-18 v3): all slots are still persisted regardless of category, but the calendar UI hides non-whitelist QVC/ShopCh slots at display time — even with `全カテゴリ` selected, and even in the `全チャンネル` view.** Category chips render only when `channelFilter` is `qvc` or `shopch` (hidden when "all channels" is selected, since a union of per-channel chips would be incoherent). In-UI whitelist lives in `components/broadcasts/UnifiedDayDetailPanel.tsx::CATEGORIES_BY_CHANNEL` (mirrors the admin-editable `channel_categories` table; RLS: read=member, write=admin). OA channels in `historical_broadcasts` have no whitelist and pass through unchanged.
- Discovery soft penalty (`lib/discovery/recent-broadcast-penalty.ts`): candidates whose `qvc.jp/product.{id}.html` URL matches a product aired on QVC within the last `BROADCAST_RECENT_LOOKBACK_DAYS` (default 30) get `BROADCAST_RECENT_PENALTY` (default 10) subtracted from `tvFitScore`. Soft only — never excludes. Applied post-curation in the daily-discovery crons. Other channels (shopch + the 13 brave site:search channels) have no product_id linkage and are silently unaffected.
- Competitor-trend boost (Phase 3-C, `lib/discovery/competitor-trend-boost.ts`): the top `HOT_CATEGORY_TOP_N` (default 5) categories aired on QVC + ShopCh within the last `HISTORICAL_LOOKBACK_DAYS` (default 30) are derived from `broadcasts.category`. Each candidate whose `name` or `category` contains any keyword (composite categories split on `・/／`) from a hot competitor category gets `HISTORICAL_CATEGORY_BOOST` (default 5) added to `tvFitScore` and a `[他局トレンド: …]` annotation on `tv_fit_reason`. Applied after the penalty step in both daily-discovery crons. `historical_broadcasts` will be unioned in once its OA-channel whitelist is configured.
- Fit-weighting layer (2026-05-18, same file): the per-category boost above is reshaped by the avg `competitor_fit_analyses.fit_score` for that category (lookback = `HISTORICAL_LOOKBACK_DAYS`, min sample = `FIT_MIN_SAMPLES`, default 3). Below the sample threshold the baseline boost is unchanged. Above it the multiplier is `1 + (avg - 50) / 25` clamped to `[0, 2.5]` — avg ≤ 25 cancels the boost entirely (the user already judged this category low-fit despite competitor airings); avg 50 is neutral; avg ≥ 87.5 amplifies 2.5×. The `[他局トレンド: …]` annotation gains a ` 適合度:NN点(n=M)` suffix when weighting was applied, so the cause is traceable in the saved row. The fit analyses themselves are written from `/api/broadcasts/analyze-fit` when the operator clicks "自社販売適合度を分析" on a calendar slot — accumulating curatorial judgement that now bends the next day's discovery scoring.
- Crawl observability (`lib/historical-crawl/runs.ts` + `/admin/historical-crawl` page): every `daily-historical-broadcasts` cron execution writes a row to `historical_crawl_runs` (admin-only RLS) with per-channel `rowCount` / `durationMs` / `error`. The admin dashboard surfaces the last 30 runs and a 7-day per-channel median; row counts dropping below 50% (red) or 80% (amber) of the median flag the channel for operator review. Treat this as the gate before adding category filtering or AI competitive analysis downstream.
- `historical_broadcasts.start_time time` (Phase 1-D, nullable): added so future parsers / re-audits can fill per-slot start times without another schema change. Of the 7 OA channels currently scraped, only senobura exposes a per-slot start time (parsed from `.onair-time`); the others stay NULL. The existing UNIQUE(channel, air_date, product_name) is left as-is — if a channel later exposes multiple distinct slots for the same product/day, the UNIQUE can be widened then.
- Competitive snapshot archival (2026-05-19, `docs/superpowers/specs/2026-05-19-competitive-snapshot-archival-design.md`): whitelist-matching slots are enriched at scrape time with a per-product detail snapshot in `broadcast_products` (name/image/price/original_price/discount_rate/sale_label/in_stock_at_capture/brand). QVC video is archived to AWS S3 + CloudFront by a separate `archive-videos` cron (JST 04:00 + 10:00) — `ffmpeg -c copy` streams the QVC m3u8 into a multipart MP4 upload. Storage key: `videos/{channel}/{air_date}/{start_time}--{broadcast_id_short}.mp4`. ShopCh video is intentionally deferred (m3u8 hosts return 403 without auth — separate PoC). UI: `BroadcastListItem` shows ▶ when `archived_video_s3` is set; clicking opens `BroadcastVideoModal` with the video + per-product list. Admin observability: `/admin/archive-status`. S3 storage via AWS SDK + CloudFront for egress. Env vars: `VIDEO_ARCHIVE_AWS_REGION`, `VIDEO_ARCHIVE_AWS_ACCESS_KEY_ID`, `VIDEO_ARCHIVE_AWS_SECRET_ACCESS_KEY`, `VIDEO_ARCHIVE_AWS_BUCKET`, `VIDEO_ARCHIVE_BASE_URL` (CloudFront distribution URL), `NEXT_PUBLIC_VIDEO_ARCHIVE_BASE_URL` (same, client-readable). The `VIDEO_ARCHIVE_AWS_*` namespace is intentional — it avoids collision with `lib/s3.ts` (product images) which uses bare `AWS_S3_*` against a different bucket + IAM key. Bucket should match the CloudFront origin; objects are public-read (no signed URLs in v1).
- Archival operations: production cron (`/api/cron/archive-videos`) handles the daily flow automatically (JST 04:00 + 10:00). For manual recovery (catch-up after env outage, force-archive a backlog, etc.) use `npm run daily:archive` which chains `backfill:broadcast-products` (enriches whitelist-matching slots — `brand_name`, `broadcast_products` rows, `video_status='queued'`) + `drain:archive-queue` (loops `archiveOne` at concurrency 4 until empty). Same workflow the cron uses internally, just executed locally. Typical full drain is ~3-5 min per ~25 slots.
- Phase C (time-slot analytics) still builds on this `broadcasts` table.

### Discovery TV Channel Source (extends home_shopping)

- Discovery pipeline tags candidates from 15 Japanese TV-shopping channels as a tier-1 priority signal so they appear above other candidates on `/[locale]/analytics/discovery/home`.
- Sources: existing `broadcasts` table for shopch + qvc (Phase A); Brave `site:` search for the other 13 channels listed in `docs/検索参考サイト (2).xlsx`.
- Persistence: `discovered_products.tv_channel_source` (comma-joined alphabetical slugs, nullable) + `tv_tier int` generated column (0=TV, 1=other) for sorting.
- Ordering: `runStage1` in `lib/discovery/orchestrator.ts` partitions candidates after scoring; API and UI both sort by `(tv_tier ASC, tv_fit_score DESC)`.
- Env knobs: `TV_CHANNEL_BRAVE_BUDGET` (default 50) caps daily Brave site:-search calls; `TV_CHANNEL_BROADCAST_WINDOW_DAYS` (default 30) sets the broadcasts lookback.
- Channel registry: `lib/discovery/tv-channels.ts` lists all 15 with slug/name/siteQuery/scraped flags. Only `scraped: true` channels (shopch, qvc) read from `broadcasts`; the rest go through Brave site: search.
- **Two-registry split — don't conflate**: `lib/discovery/tv-channels.ts` (15 channels) drives discovery candidate sourcing. `lib/broadcasts/channel-style.ts` (9 channels = qvc + shopch + 7 OA) drives the broadcasts calendar UI. The OA list is a strict subset whose schedule pages we can actually scrape; the remaining 6 (kachimo / kaidoki / kantv / ichiban / rakurakum / ropping) live only in discovery via Brave because their schedule pages don't exist or aren't parseable.

### Strategy ↔ Discovery Pool 統合 (2026-05-13)

- 戦略立案 (`/api/analytics/md-strategy`) 의 신상품 발굴 (`discoverNewProducts`) 은 항상 `discovered_products` 풀을 1차 소스로 사용한다.
- Pool query: `lib/strategy/pool-query.ts` — context · category(fuzzy via `CATEGORY_MAPPING`) · price · 60일 lookback · `tv_tier ASC, tv_fit_score DESC` 정렬.
- Lightweight 모드(워크플로 기본): pool target 30. Full 모드: target 12. 풀이 채워지면 Rakuten/Brave 외부 호출 skip; 부족분만 fresh search 로 채움.
- 다중 시드: URL `?seedIds=a,b,c` 또는 body `seedProductIds: string[]` → 모든 시드의 `c_package` 가 Gemini 프롬프트에 주입 (`formatMultiSeedPromptSection`), 시드 ID 는 pool query 에서 자동 제외.
- 출처 태그: `pool_source: 'discovery_pool' | 'fresh_search' | 'seed'` + `discovered_product_id` 를 추천 상품에 부착해 UI 배지로 노출.
- Fail-open: 카테고리/가격 필터 결과가 5개 미만이면 해당 필터를 무시 (관대 매치). 풀이 완전히 비면 기존 fresh-only 경로로 폴백.
- Env: `STRATEGY_POOL_LOOKBACK_DAYS` (default 60).
- Test alias: `npm run test:strategy-pool`.

### Supabase Schema (key tables)

- `products` — uploaded product metadata, status lifecycle: pending → extracted → analyzing → completed/failed
- `research_results` — AI-generated research (marketability, demographics, seasonality, COGS, competitors, pricing, etc.)
- `product-files` bucket — uploaded file storage

### Report Sections (components/report/)

13 report section components: Marketability, Demographics, Seasonality, COGS, Influencers, ContentIdeas, Competitor, BroadcastScript, JapanExport, DistributionChannel, PricingStrategy, MarketingStrategy, KoreaMarket. Plus PdfDownload (client-side via html2canvas + jspdf).

## Key Conventions

- **i18n**: All UI text via next-intl. Translation files in `messages/en.json` and `messages/ja.json`. Research output is in Japanese.
- **UI**: shadcn/ui (base-nova style) + Tailwind CSS 4 + Lucide icons. Components in `components/ui/`.
- **Path alias**: `@/*` maps to project root.
- **Vercel deployment**: Function timeouts configured in `vercel.json` (synthesize: 300s, analyze: 120s, recommend: 60s). Daily cron at 9 AM UTC for data refresh.
- **Server Actions**: body size limit set to 50MB for large file uploads.
- **Auth (added 2026-05-13)**: Three roles — `admin`, `member`, `viewer` — gated by Supabase Auth via `@supabase/ssr`. Code reached from a user request must use `lib/supabase/server.ts::getServerClient()` for queries and `lib/auth/require-user.ts::requireUser([roles])` at the top of every API route. `getServiceClient()` is reserved for cron, workflow steps, and other non-user-initiated paths — it bypasses RLS. Internal server-to-server fetches (e.g. `/api/analyze` → `/api/analyze/synthesize`, `/api/discovery/enrich/[id]` → `/worker`) authenticate via `Bearer ${CRON_SECRET}` and `hasInternalSecret()`. RLS is the last line of defence — when adding a new table, also add a Group A (TXD, viewer-readable) or Group B (internal, member/admin-only) policy. See `docs/superpowers/specs/2026-05-13-auth-and-tiered-access-design.md`.
