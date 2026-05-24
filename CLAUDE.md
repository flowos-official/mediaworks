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

- `app/[locale]/` — i18n routing (ja, ko; default: ja) via next-intl
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
- UI: `/[locale]/broadcasts` — month grid + sticky right-side `UnifiedDayDetailPanel` (covers all 10 channels with schedule data: QVC, ShopCh, and 8 OA channels in one list with channel + category chip filters). Below the calendar, a separate `HistoricalBroadcasts` panel offers free-text history search across **all 10 channels** (QVC + ShopCh from `broadcasts` table, 8 OA from `historical_broadcasts`). `/api/broadcasts` accepts `?search=` (program_title ilike); the panel calls both endpoints in parallel and merges results client-side. No date coupling — empty until the user enters a search term or picks a channel chip. (btops was removed 2026-05-17 — site closed.)
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
- **Two-registry split — don't conflate**: `lib/discovery/tv-channels.ts` (15 channels) drives discovery candidate sourcing. `lib/broadcasts/channel-style.ts` (10 channels = qvc + shopch + 8 OA, with ropping + kantv being added 2026-05-21) drives the broadcasts calendar UI. The OA list is a strict subset whose schedule pages we can actually scrape; the remaining 4 (kachimo / kaidoki / ichiban / rakurakum) live only in discovery via Brave because their schedule pages don't exist or aren't parseable.

### Strategy ↔ Discovery Pool 統合 (2026-05-13)

- 戦略立案 (`/api/analytics/md-strategy`) 의 신상품 발굴 (`discoverNewProducts`) 은 항상 `discovered_products` 풀을 1차 소스로 사용한다.
- Pool query: `lib/strategy/pool-query.ts` — context · category(fuzzy via `CATEGORY_MAPPING`) · price · 60일 lookback · `tv_tier ASC, tv_fit_score DESC` 정렬.
- Lightweight 모드(워크플로 기본): pool target 30. Full 모드: target 12. 풀이 채워지면 Rakuten/Brave 외부 호출 skip; 부족분만 fresh search 로 채움.
- 다중 시드: URL `?seedIds=a,b,c` 또는 body `seedProductIds: string[]` → 모든 시드의 `c_package` 가 Gemini 프롬프트에 주입 (`formatMultiSeedPromptSection`), 시드 ID 는 pool query 에서 자동 제외.
- 출처 태그: `pool_source: 'discovery_pool' | 'fresh_search' | 'seed' | 'research'` + `discovered_product_id` (2026-05-25 이후 `fresh_search`/`research` 도 strategy 생성 시점에 `discovered_products` 풀에 자동 저장되므로 항상 보유 — Product Selection Pipeline Phase 0 참고) 를 추천 상품에 부착해 UI 배지로 노출.
- Fail-open: 카테고리/가격 필터 결과가 5개 미만이면 해당 필터를 무시 (관대 매치). 풀이 완전히 비면 기존 fresh-only 경로로 폴백.
- Env: `STRATEGY_POOL_LOOKBACK_DAYS` (default 60).
- Test alias: `npm run test:strategy-pool`.

### Product Selection Pipeline (2026-05-25)

- 4-stage operator workflow on top of the existing `sourced` feedback: **선택됨(selected) → 소싱중(sourcing) → 방송예정(scheduled) → 종료(closed)**. `closed_reason ∈ {aired, dropped, postponed}`. Spec: `docs/superpowers/specs/2026-05-24-product-selection-pipeline-design.md`; plan: `docs/superpowers/plans/2026-05-24-product-selection-pipeline.md`.
- Tables (migration `2026-05-24_product_selections.sql`):
  - `product_selections` — id, `discovered_product_id` FK (cascade), `status`, `owner_id` (RESTRICT) / `assignee_id` (SET NULL), `broadcast_id` FK (SET NULL), closed_{reason,at,by,note}, {sourcing,scheduled,closed}_note. Partial unique `(discovered_product_id) WHERE status != 'closed'` enforces "at most one active selection per product"; re-selection after close is allowed. CHECK constraints: `scheduled_requires_anchor` (broadcast_id OR scheduled_note), `closed_requires_reason` (reason + closed_at).
  - `product_selection_events` — append-only audit log; event_types: `created | status_changed | assignee_changed | broadcast_linked | broadcast_unlinked | closed | reopened | note_updated`. `is_system=true` marks cron-emitted events. No UPDATE/DELETE policy (immutable).
- RLS Group A: SELECT for all authenticated (viewer included for read-only board); INSERT/UPDATE for member|admin via separate `ps_insert` + `ps_update` policies (no DELETE for any role except service). `pse_select` open, `pse_insert` member|admin only.
- Phase 0 unification (entry points into the pipeline):
  - Both `/discovery/home` AND `/strategy/expansion` cards render `FeedbackButtons` — strategy expansion previously lacked it; this was the structural gap closed in Phase 0.
  - `lib/strategy/fresh-search-persist.ts::persistStrategyFreshSearch` runs during strategy generation (called from `lib/workflows/md-strategy.workflow.ts::persistFreshSearchStep`). Every `fresh_search` / `research` rec gets a stub `discovered_products` row in a synthetic `discovery_runs` session (status `running` → `completed` on success, `failed` on bulk-insert error so `reconcileStaleDiscoveryRuns` can clean it). The strategy doc JSONB then carries `discovered_product_id` for every rec uniformly. **The `prevent_recent_duplicate_discoveries` BEFORE INSERT trigger may silently skip URLs already in another recent session — the helper follows up with a SELECT recovery pass so `idByUrl` always returns an id.**
- Selection creation/auto-close inside the existing feedback handler (`app/api/discovery/feedback/route.ts`):
  - `sourced` ON → if no active selection exists for that product, INSERT one with `status='selected'`, `owner_id=auth.uid()`, emit `created` event.
  - `sourced` toggled OFF by the same user → if the active selection is still in `selected` stage, auto-close with `closed_reason='dropped'` and emit `status_changed` + `closed`. Selections already advanced past `selected` are preserved — operator has invested work into them.
- API endpoints (all `requireUser(['member','admin'])` except reads which include `viewer`; all use `auth.sb` so RLS applies):
  - `GET /api/selections` — board grouped by status. Filters `?scope=mine_owned|mine_assigned`, `?assignee=<id|all>`, `?includeClosed=1` (closed last 7 days only). `?q=` is currently a no-op (PostgREST cannot filter on embedded resource via supabase-js — v1 trade-off; filter client-side).
  - `GET /api/selections/counts` — active count by stage + total. Powers the nav badge.
  - `POST /api/selections/:id/move` — stage transition with optimistic lock (`UPDATE ... WHERE id=? AND status=<expected_from>`, 409 on miss). VALID transitions: `selected → {sourcing, closed}`, `sourcing → {selected, scheduled, closed}`, `scheduled → {sourcing, closed}`, `closed → {}` (use `/reopen`). `scheduled` requires `broadcast_id` OR `scheduled_note`; `closed` requires `closed_reason`.
  - `POST /api/selections/:id/assign` — assignee change. Emits `assignee_changed` with from/to.
  - `POST /api/selections/:id/reopen` — `closed → sourcing`, clears `closed_*` fields; 409 if another active selection has since taken over the same product.
  - `PATCH /api/selections/:id/note` — inline edit on `sourcing_note` / `scheduled_note` / `closed_note`. 400 on invalid field, 404 if selection not found.
  - `GET /api/selections/:id/events` — timeline read (viewer allowed).
  - `GET /api/selections/match-broadcast?productName=&channel=&from=&to=` — broadcast candidate search with Jaccard-style name similarity. Returns `{ suggestions: top-6 score > 0.15, others: top-30 score ≤ 0.15 }`.
- UI:
  - `/[locale]/analytics/pipeline` — server page, `auth.sb` data fetch, 4-column kanban with `@dnd-kit` drag-drop, optimistic move + revert on 409/500. Cards include thumbnail, name, price/TV-fit, stage-specific pill (broadcast slot / note / closed reason), owner→assignee footer. `?focus=<selection_id>` deep-link scrolls + ring-highlights the card for 1.5s. Korean stage labels (선택됨/소싱중/방송예정/종료) hardcoded in `KanbanBoard.tsx` for v1.
  - Card menu (`components/pipeline/CardMenu.tsx`): 이력 보기 (`EventsTimelineModal`), 원본 상품 보기, 종료 처리 / 다시 소싱으로 (context-sensitive). **`window.prompt` is a v1 placeholder for the closed-reason picker — replace with shadcn dialog in Phase 2.**
  - Drag-to-scheduled opens `BroadcastMatchDialog` (`components/pipeline/BroadcastMatchDialog.tsx`) — searches `broadcasts` by name + channel + date range, or accepts a free-text `scheduled_note` for slots the table does not yet contain.
  - `PipelineStatusChip` (`components/pipeline/PipelineStatusChip.tsx`) renders on discovery + strategy cards when an active selection exists. Click → `/analytics/pipeline?focus=<id>`. Discovery cards get `active_selection` via the server-side join in `/api/discovery/today`; strategy cards fetch via a single bulk `/api/selections` call inside `DiscoveredProductsHero`'s `useEffect`.
- Navigation: market group gains a 4th member at `/analytics/pipeline` (after broadcasts/discovery/strategy). Navbar shows the active-selection count badge via `/api/selections/counts` (server-fetched, graceful 0-on-error). Viewer is on the allowlist (`lib/auth/route-permissions.ts::VIEWER_ALLOWED_PATH_PREFIXES`).
- Cache invalidation:
  - `lib/selections/cached.ts::invalidateSelectionsAfterMutation(source)` revalidates tags `selections:board` + `selections:counts` on every write (feedback handler, all `/api/selections/*` mutations, cron auto-advance).
  - `lib/discovery/cached.ts::MUTATION_TAGS` includes the selection tags too — discovery-side mutations refresh the board chip data on existing cards.
- Daily cron `/api/cron/pipeline-auto-advance` (JST 03:00 = UTC 18:00, `vercel.json`): closes `scheduled` selections whose linked `broadcast.air_date < today_jst` with `closed_reason='aired'`, `closed_at = ${airDate}T12:00:00+09:00`, `closed_by=null`, `is_system=true`. Emits `status_changed` + `closed` events. Defensive `WHERE status='scheduled'` on the UPDATE. Manual-note (`broadcast_id IS NULL`) scheduled selections are NOT touched — operator must close them by hand.
- Backfill: the migration ports existing `discovered_products.user_action='sourced'` rows whose original author is recoverable from `product_feedback` (with `user_id IS NOT NULL` guard) into new `product_selections` rows with `status='selected'`, plus a `created` event marked `is_system=true` with a `Backfilled from ...` note. Rows without a recoverable author are skipped — the user can re-toggle `sourced` to enter the board normally.
- Tests: `npm run test:selections` (state-machine invariants + partial unique + CHECK constraints against live DB), `npm run test:strategy-fresh-search` (persistence helper + dedup recovery against live DB). Both require `.env.local` and at least one row in `profiles`.
- Phase 2+ follow-ups (out of scope for this drop): `FiltersBar` UI for `?scope=/?assignee=/?q=/?includeClosed=`; shadcn dialog replacing `window.prompt` for close reason; `/api/selections` response caching; `PipelineStatusChip` locale i18n (currently mixes JP prefix `パイプライン:` with KR stage labels); numerical sales/revenue/ROI input on closed cards; structured supplier/PO fields; multi-broadcast per selection; notifications.

### Supabase Schema (key tables)

- `products` — uploaded product metadata, status lifecycle: pending → extracted → analyzing → completed/failed
- `research_results` — AI-generated research (marketability, demographics, seasonality, COGS, competitors, pricing, etc.)
- `product_selections` — operator pipeline: 4-stage state machine (selected/sourcing/scheduled/closed) on top of `discovered_products`. See Product Selection Pipeline section.
- `product_selection_events` — append-only audit log for `product_selections` transitions, assignments, notes.
- `product-files` bucket — uploaded file storage

### Report Sections (components/report/)

13 report section components: Marketability, Demographics, Seasonality, COGS, Influencers, ContentIdeas, Competitor, BroadcastScript, JapanExport, DistributionChannel, PricingStrategy, MarketingStrategy, KoreaMarket. Plus PdfDownload (client-side via html2canvas + jspdf).

## Key Conventions

- **i18n**: All UI text via next-intl. Translation files in `messages/ja.json` and `messages/ko.json` (default locale: ja). Research output is in Japanese.
- **UI**: shadcn/ui (base-nova style) + Tailwind CSS 4 + Lucide icons. Components in `components/ui/`.
- **Path alias**: `@/*` maps to project root.
- **Vercel deployment**: Function timeouts configured in `vercel.json` (synthesize: 300s, analyze: 120s, recommend: 60s). Daily cron at 9 AM UTC for data refresh.
- **Server Actions**: body size limit set to 50MB for large file uploads.
- **Auth (added 2026-05-13)**: Three roles — `admin`, `member`, `viewer` — gated by Supabase Auth via `@supabase/ssr`. Code reached from a user request must use `lib/supabase/server.ts::getServerClient()` for queries and `lib/auth/require-user.ts::requireUser([roles])` at the top of every API route. `getServiceClient()` is reserved for cron, workflow steps, and other non-user-initiated paths — it bypasses RLS. Internal server-to-server fetches (e.g. `/api/analyze` → `/api/analyze/synthesize`, `/api/discovery/enrich/[id]` → `/worker`) authenticate via `Bearer ${CRON_SECRET}` and `hasInternalSecret()`. RLS is the last line of defence — when adding a new table, also add a Group A (TXD, viewer-readable) or Group B (internal, member/admin-only) policy. See `docs/superpowers/specs/2026-05-13-auth-and-tiered-access-design.md`.
  - **Page components must `redirect()` on auth failure, not `return auth.error`** — `auth.error` is a `NextResponse` which is valid in API routes but rejected by Next.js's Page component build check. Pattern: `if ("error" in auth) redirect(localePath(locale, "/login"))`. API routes (`app/api/.../route.ts`) keep using `return auth.error`.
  - **`viewer` route allowlist**: viewers are redirected to `/analytics/products` for any path not in `lib/auth/route-permissions.ts::VIEWER_ALLOWED_PATH_PREFIXES`. When adding a new viewer-readable page, extend that array (currently `/analytics/products`, `/guide`, `/analytics/pipeline`).
- **`server-only` import + tsx smoke compatibility**: lib files that you intend to directly import from a `scripts/test-*.ts` smoke script (run via `tsx --env-file=.env.local`) must NOT include `import "server-only"` — the package throws at module load when not running under Next.js's bundler alias, so tsx fails immediately. Rely on `getServiceClient` (uses `SUPABASE_SERVICE_ROLE_KEY`) as the server-side guard instead. Files that are only ever imported via Next.js route handlers can keep the import. Example: `lib/strategy/fresh-search-persist.ts` deliberately omits it; `lib/discovery/cached.ts` keeps it because no smoke imports it directly.
