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
