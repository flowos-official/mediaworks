# Live Commerce Analytics Tab — Design Spec

## Context

The home shopping (TV commerce) market in Japan is shrinking. The business needs to diversify into live commerce platforms (TikTok Live, Instagram Live, YouTube Live, Rakuten ROOM LIVE, etc.). This feature adds a new analytics tab that researches the Japanese live commerce market in real-time via Brave Search and generates strategic entry plans via Gemini AI, following the proven MDStrategyPanel SSE multi-skill pipeline pattern.

## Scope

- New 4th tab in Analytics dashboard: **ライブコマース**
- SSE streaming pipeline with Brave Search + Gemini (6 skills)
- Strategy persistence to Supabase with history/reload
- Japanese market focus (all output in Japanese)

## Architecture

### Tab Integration

Add `live-commerce` tab to `AnalyticsDashboard.tsx` (alongside 概要, 商品分析, 拡大戦略).

```typescript
const tabs = [
  { key: 'overview', label: '概要' },
  { key: 'products', label: '商品分析' },
  { key: 'expansion', label: '拡大戦略' },
  { key: 'live-commerce', label: 'ライブコマース' },  // NEW
];
```

The `LiveCommercePanel` component is dynamically imported (same pattern as `MDStrategyPanel`).

### Skill Pipeline (6 skills)

| # | Skill Name | Purpose | Input |
|---|-----------|---------|-------|
| 0 | `goal_analysis` | Parse user goal into structured objectives | User text input |
| 1 | `market_research` | Research JP live commerce market via Brave Search + Gemini synthesis | Search results + parsed goal |
| 2 | `platform_analysis` | Deep-dive each platform (fees, demographics, success patterns, entry difficulty) | Market research + search results |
| 3 | `content_strategy` | Platform-specific content plans (format, timing, host style, engagement tactics) | Platform analysis + optional product data |
| 4 | `execution_plan` | Monthly roadmap, investment, staffing, KPIs | All prior skill outputs |
| 5 | `risk_analysis` | Risk matrix with mitigation strategies | All prior skill outputs |

Each skill: Gemini call with 90s timeout, JSON output, error fallback to `{}`.

### Data Flow

```
User Input (goal text, optional platform preferences)
  → POST /api/analytics/live-commerce (SSE stream)
    → Phase 1: Brave Search (6-8 Japanese market queries in parallel)
    → Phase 2: Fetch existing product data from DB (reference only, not central)
    → Phase 3: 6 skills sequential execution via Gemini
      → Each skill emits: progress(running) → progress(complete) + skill_result
    → Phase 4: Save to `live_commerce_strategies` table
    → SSE event: complete { strategyId, generatedAt }
  → Client renders results in real-time as each skill completes
```

### Brave Search Queries

Static queries (always run):
- `日本 ライブコマース 市場規模 2025 2026`
- `ライブコマース プラットフォーム 比較 日本`
- `TikTok Live 日本 売上 成功事例`
- `Instagram ライブ販売 日本 戦略`
- `YouTube Live ショッピング 日本`
- `楽天ROOM LIVE 出店 手数料`

Dynamic queries (based on user goal):
- Extract keywords from parsed goal → 1-2 additional searches

### Platform Reference Table

Hardcoded facts (no Gemini lookup needed), similar to `CHANNEL_REFERENCE` in md-strategy.ts:

```typescript
const PLATFORM_REFERENCE = [
  { name: "TikTok Live", commission: "2-8%", minFollowers: "1,000+", demographics: "10-30代", avgViewers: "100-10,000", entryDifficulty: "中" },
  { name: "Instagram Live", commission: "5%", minFollowers: "制限なし", demographics: "20-40代女性", avgViewers: "50-5,000", entryDifficulty: "低" },
  { name: "YouTube Live", commission: "0% (Super Chat 30%)", minFollowers: "50+", demographics: "全年齢", avgViewers: "50-50,000", entryDifficulty: "中" },
  { name: "楽天ROOM LIVE", commission: "楽天手数料に含む", minFollowers: "制限なし", demographics: "30-50代", avgViewers: "50-2,000", entryDifficulty: "低" },
  { name: "Yahoo!ショッピング LIVE", commission: "Yahoo!手数料に含む", minFollowers: "出店者のみ", demographics: "30-50代", avgViewers: "50-1,000", entryDifficulty: "中" },
];
```

## File Structure

### New files

```
lib/live-commerce-strategy.ts                         — Skill pipeline, Gemini prompts, types
app/api/analytics/live-commerce/route.ts              — SSE API (POST: generate, GET: list)
app/api/analytics/live-commerce/[id]/route.ts         — GET: load saved, DELETE: remove
components/analytics/LiveCommercePanel.tsx             — Main panel (input form + progress + results)
components/analytics/live-commerce/
  ├── MarketOverviewSection.tsx                       — Market size, growth, trends visualization
  ├── PlatformAnalysisSection.tsx                     — Platform comparison cards with scores
  ├── ContentStrategySection.tsx                      — Per-platform content plans
  ├── ExecutionPlanSection.tsx                        — Timeline/roadmap visualization
  └── RiskAnalysisSection.tsx                         — Risk matrix
```

### Modified files

```
components/analytics/AnalyticsDashboard.tsx            — Add 4th tab + dynamic import
vercel.json                                            — Add live-commerce route timeout (300s)
```

### Reused patterns from existing code

- `lib/md-strategy.ts` — `callGemini()`, `parseJSON()`, `braveSearchStructured()` patterns (duplicate into new file to keep independence)
- `components/analytics/md-strategy/StrategyProgress.tsx` — Progress UI pattern (adapt for 6 skills)
- `components/analytics/md-strategy/StrategyHistory.tsx` — History list pattern
- `components/analytics/MDStrategyPanel.tsx` — SSE client consumption pattern
- `app/api/analytics/md-strategy/route.ts` — SSE API route pattern

## Database

### New table: `live_commerce_strategies`

```sql
create table live_commerce_strategies (
  id uuid primary key default gen_random_uuid(),
  user_goal text,
  target_platforms text[],
  market_research jsonb,
  platform_analysis jsonb,
  content_strategy jsonb,
  execution_plan jsonb,
  risk_analysis jsonb,
  search_sources jsonb,
  created_at timestamptz default now()
);

-- RLS: service role only (same pattern as md_strategies)
alter table live_commerce_strategies enable row level security;
```

## UI Design

### Input Form

- Goal text input (placeholder: "例: TikTok Liveを中心に月商1000万円を目指したい")
- Optional: platform checkboxes (TikTok, Instagram, YouTube, Rakuten, Yahoo!)
- Generate button
- History dropdown (load previous strategies)

### Results Layout

6 sections rendered as each skill completes, using card-based layout consistent with MDStrategyPanel:

1. **市場概況** (Market Overview) — Market size stats, growth chart, key trends as bullet points
2. **プラットフォーム分析** (Platform Analysis) — Side-by-side cards per platform with fit scores, pros/cons, recommended products
3. **コンテンツ戦略** (Content Strategy) — Per-platform tabs with broadcast format, timing, host guidelines
4. **実行ロードマップ** (Execution Plan) — Monthly timeline visualization with milestones, investment amounts, staffing
5. **リスク分析** (Risk Analysis) — Risk cards with severity/probability scores and mitigation plans
6. **出典** (Sources) — Brave Search source citations with URLs

### Progress Indicator

Vertical progress stepper (same as StrategyProgress) showing 6 skills with running/complete/error states.

## SSE Event Protocol

Same as md-strategy:

```
event: progress
data: {"skill":"market_research","status":"running","index":1,"total":6}

event: skill_result
data: {"skill":"market_research","index":1,"total":6,"data":{...}}

event: skill_error
data: {"skill":"market_research","error":"..."}

event: complete
data: {"generatedAt":"...","strategyId":"uuid"}

: heartbeat (every 10s)
```

## Verification

1. `npx tsc --noEmit` — No type errors
2. `npm run dev` → Navigate to `/ja/analytics` → Click ライブコマース tab
3. Enter a goal → Click generate → Verify SSE progress shows 6 skills
4. Verify each section renders as skills complete
5. Verify strategy saves to DB → Reload page → Load from history
6. Verify Brave Search sources appear in citations section
7. Test error handling: disconnect network mid-stream → Verify graceful error display
