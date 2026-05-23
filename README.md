# MediaWorks

MediaWorks is a home-shopping research and recommendation system. It combines
internal product and sales data with competitor broadcast/discovery data to
recommend new products and produce sales execution artifacts such as MD
strategies, research reports, and TV scripts.

The detailed current-state map is in
[`docs/current-system-feature-map.md`](docs/current-system-feature-map.md).
The completion audit is in
[`docs/recommendation-system-completion-audit.md`](docs/recommendation-system-completion-audit.md).
The Korean user manual is in
[`docs/user-guide-ko.md`](docs/user-guide-ko.md).
The day-to-day operator guide is in
[`docs/user-guide-jp.md`](docs/user-guide-jp.md).

## Core Flow

1. Upload internal product ledgers and sales data.
2. Collect current QVC, Shop Channel, and other OA broadcast data.
3. Run daily product discovery for `home_shopping` and `live_commerce`.
4. Enrich promising discovery candidates into C packages.
5. Promote enriched candidates into Research products.
6. Synthesize Research reports with competitor context.
7. Generate MD Strategy using internal sales evidence plus external candidates.
8. Generate product-linked screenplays from Research products.

The strict proof gate for this flow is:

```bash
npm run smoke:recommendation-flow:strict
```

It fails unless the database contains completed latest discovery runs for both
`home_shopping` and `live_commerce`, a promoted discovery product, a completed
Research result, an MD Strategy that includes both internal evidence and at
least one Discovery-pool external candidate, and a ready product-linked
screenplay.

## Main Areas

| Area | Primary UI | Main Data |
| --- | --- | --- |
| Internal sales analytics | `/ja/analytics/overview`, `/ja/analytics/products` | `product_details`, `product_summaries`, `annual_summaries`, `sales_weekly` |
| Competitor broadcast calendar | `/ja/broadcasts` | `broadcasts`, `broadcast_products`, `historical_broadcasts` |
| Product discovery | `/ja/analytics/discovery/home`, `/ja/analytics/discovery/live` | `discovery_runs`, `discovered_products`, `learning_state`, `product_feedback` |
| Research | `/ja/products/[id]` | `products`, `product_files`, `research_results` |
| MD Strategy | `/ja/analytics/strategy/expansion` | `md_strategies`, sales summaries, discovery/research pools |
| Live Commerce Strategy | `/ja/analytics/strategy/live` | live strategy runs and discovery context |
| Screenplays | `/ja/screenplays` | `screenplays`, `screenplay_versions` |
| Admin operations | `/ja/admin/*` | users, registry, crawl/archive status |

## Local Setup

Install dependencies:

```bash
npm install
```

Create `.env.local` from `.env.example` and fill in the real credentials:

```bash
copy .env.example .env.local
```

Run the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Required Environment

The application expects these environment groups:

| Group | Variables |
| --- | --- |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Internal auth | `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL` |
| AI/search | `GEMINI_API_KEY`, `BRAVE_SEARCH_API_KEY`, `RAKUTEN_APPLICATION_ID`, `RAKUTEN_ACCESS_KEY` |
| Product images | `AWS_S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` |
| Broadcast video archive | `VIDEO_ARCHIVE_AWS_REGION`, `VIDEO_ARCHIVE_AWS_ACCESS_KEY_ID`, `VIDEO_ARCHIVE_AWS_SECRET_ACCESS_KEY`, `VIDEO_ARCHIVE_AWS_BUCKET`, `NEXT_PUBLIC_VIDEO_ARCHIVE_BASE_URL` |
| Optional tuning | `DISCOVERY_TARGET_COUNT`, `STRATEGY_POOL_LOOKBACK_DAYS`, `TV_CHANNEL_BRAVE_BUDGET` |

Do not commit real secrets.

## Operator Commands

Check the current recommendation pipeline state:

```bash
npm run smoke:recommendation-flow
```

Run the strict end-to-end proof gate:

```bash
npm run smoke:recommendation-flow:strict
```

Authenticated members/admins can read the same readiness checks through:

```text
GET /api/recommendation-flow/status
```

The same checks are visible in the app at:

```text
/ja/analytics/strategy/status
```

That status page also shows data-grounding coverage for category
normalization, broadcast category metadata, and operator fit analysis category
metadata. These are operational warnings: they do not block the strict product
flow by themselves, but they explain when recommendations may be based on thin
or uneven competitor evidence.

As of the current verified database state, the status page reports all checks
passing: Discovery raw category coverage is `428/428`, the normalization cache
has `1330` rows, broadcast category coverage is `23.7%` (`QVC/ShopCh
1402/1668`, `OA 10671/49320`), and operator fit category coverage is `2/2`.

Inspect or apply Discovery to Research promotion:

```bash
npm run promote:discovery-research
npx tsx --env-file=.env.local scripts/promote-discovered-to-research.ts --id=<discovered_product_id> --apply
```

Plan or execute the full recommendation path:

```bash
npm run complete:recommendation-flow
npx tsx --env-file=.env.local scripts/complete-recommendation-flow.ts --id=<discovered_product_id> --apply --run-synthesis --create-screenplay --wait
```

Backfill OA broadcast categories in controlled batches:

```bash
npm run backfill:historical-categories
npx tsx --env-file=.env.local scripts/backfill-historical-broadcast-categories.ts --row-limit=200 --max-products=20 --apply
```

Dry runs report `plannedRows` using the exact remaining null-category row count
for the selected product names, so the estimate can be larger than the sampled
`--row-limit` distribution.

Backfill operator fit analysis categories from matching broadcast slots:

```bash
npx tsx --env-file=.env.local scripts/backfill-operator-fit-categories.ts --limit=100 --apply
```

Run user-guide scenario checks:

```bash
npm run test:user-guide
```

## Verification

Use these commands before handing off changes:

```bash
npm run lint
npx tsc --noEmit
npm run test:migrations
npm run smoke:recommendation-flow:strict
```

Focused checks for this integration:

```bash
npx tsx --env-file=.env.local scripts/test-analyze-internal-auth.ts
npx tsx --env-file=.env.local scripts/test-research-synthesis-service.ts
npm run test:category-normalize
npm run test:historical-category-backfill
npm run test:operator-fit-category-backfill
npm run test:research-category-candidates
npm run test:recommendation-flow-status
npm run test:recommendation-flow-status-view
npm run test:strategy-sub-tabs-i18n
npm run test:strategy-category-mapping
npx tsx --env-file=.env.local scripts/test-recommendation-flow-readiness.ts
npx tsx --env-file=.env.local scripts/test-recommendation-operator-flow.ts
npx tsx --env-file=.env.local scripts/test-recommendation-strategy-evidence.ts
npm run test:strategy-pool
npm run test:tv-evidence-unit
```

`npm run lint` currently exits with code 0 but still reports warnings in older
files. Treat new errors as blockers.

## Cron Schedule

Vercel schedules are stored in `vercel.json`. Times below use UTC and
JST/KST (UTC+9).

| UTC | JST/KST | Path | Purpose |
| --- | --- | --- | --- |
| 09:00 daily | 18:00 daily | `/api/cron/daily-refresh` | Refresh uploaded Research products |
| 23:00 daily | 08:00 next day | `/api/cron/daily-discovery-home` | Home-shopping discovery |
| 23:30 daily | 08:30 next day | `/api/cron/daily-discovery-live` | Live-commerce discovery |
| 16:00 daily | 01:00 next day | `/api/cron/daily-broadcasts` | QVC/Shop Channel schedule and snapshots |
| 16:30 daily | 01:30 next day | `/api/cron/daily-historical-broadcasts` | OA channel crawl |
| 17:00 daily | 02:00 next day | `/api/cron/qvc-monthly-refresh` | QVC monthly refresh |
| 22:45 daily | 07:45 next day | `/api/cron/daily-learning` | Feedback and learning update |
| 01:00 Monday | 10:00 Monday | `/api/cron/weekly-insights` | Weekly discovery insight generation |
| 17:30 Sunday | 02:30 Monday | `/api/cron/refresh-tv-evidence` | Refresh stale TV evidence |
| 19:00 daily | 04:00 next day | `/api/cron/archive-videos` | Broadcast video archive worker |
| 01:00 daily | 10:00 daily | `/api/cron/archive-videos` | Broadcast video archive worker |

Cron and internal worker calls use `Authorization: Bearer <CRON_SECRET>`.

## Troubleshooting

If upload analysis stays stuck, verify `CRON_SECRET` and run:

```bash
npx tsx --env-file=.env.local scripts/test-analyze-internal-auth.ts
```

If Discovery has candidates but no Research product, run:

```bash
npm run promote:discovery-research
```

If the MD Strategy does not show both internal and external evidence, run:

```bash
npm run smoke:recommendation-flow:strict
```

Then inspect the missing prerequisite in the failure message.
