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
| Google Gemini | Vision extraction + research synthesis (gemini-3-flash-preview) | `GEMINI_API_KEY` |
| Brave Search | Web research queries | `BRAVE_SEARCH_API_KEY` |
| Rakuten API | Japan market product ranking data | `RAKUTEN_APP_ID` |

### Broadcast Calendar (Phase A — read-only)

- Daily JST 01:00 cron (`16:00 UTC` → `app/api/cron/daily-broadcasts/route.ts`) scrapes yesterday's broadcasts from Shop Channel (`shopch.jp`) and QVC Japan (`qvc.jp`) via cheerio.
- Read API: `GET /api/broadcasts?from=YYYY-MM-DD&to=YYYY-MM-DD[&channel=shopch|qvc]` (max 62-day range).
- Admin recovery: `POST /api/broadcasts/refresh` with `{date}` or `{from,to}` (max 7 days), `Bearer ${CRON_SECRET}`.
- UI: `/[locale]/broadcasts` — month grid + time-sorted unified day list with channel filter.
- Module layout: `lib/broadcasts/{types,fetch,shopch,qvc,persist,index}.ts`.
- Fixture-based parser tests: `npm run test:broadcasts-parsers`. Live integration: `npm run test:broadcasts-live`. Operational diagnostic: `npm run verify:broadcasts`. One-shot 7-day backfill: `npm run backfill:broadcasts -- --days=7`.
- Phase B PoC (QVC only): `broadcasts.product_ids text[]` is populated from each slot's `data-products` attribute; `qvc_products` caches OG metadata (name, image, price text, video) fetched from `qvc.jp/product.{id}.html`. The daily cron auto-enriches new IDs; manual run via `npm run enrich:qvc-products`. Shop Channel product detail requires JS rendering (Playwright) and is deferred.
- Phase C (time-slot analytics) still builds on this `broadcasts` table.

### Discovery TV Channel Source (extends home_shopping)

- Discovery pipeline tags candidates from 12 Japanese TV-shopping channels as a tier-1 priority signal so they appear above other candidates on `/[locale]/analytics/discovery/home`.
- Sources: existing `broadcasts` table for shopch + qvc (Phase A); Brave `site:` search for the other 10 channels listed in `docs/検索参考サイト (2).xlsx`.
- Persistence: `discovered_products.tv_channel_source` (comma-joined alphabetical slugs, nullable) + `tv_tier int` generated column (0=TV, 1=other) for sorting.
- Ordering: `runStage1` in `lib/discovery/orchestrator.ts` partitions candidates after scoring; API and UI both sort by `(tv_tier ASC, tv_fit_score DESC)`.
- Env knobs: `TV_CHANNEL_BRAVE_BUDGET` (default 50) caps daily Brave site:-search calls; `TV_CHANNEL_BROADCAST_WINDOW_DAYS` (default 30) sets the broadcasts lookback.
- Channel registry: `lib/discovery/tv-channels.ts` lists all 12 with slug/name/siteQuery/scraped flags. Only `scraped: true` channels (shopch, qvc) read from `broadcasts`; the rest go through Brave site: search.

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
