# Insights Dashboard Design Spec (Phase 6)

- **Date**: 2026-04-18
- **Status**: Draft
- **Target**: 商品発掘 하위에 "インサイト" 서브탭 추가, 선택(selection) + 통계(statistics) 2단 탭 구조로 피드백 + 차트 시각화.

---

## 1. 목적

사용자가 발굴한 제품에 대한 피드백(소싱/관심/거절/중복)이 쌓이면서, 그 패턴을 한눈에 볼 수 있는 대시보드가 필요하다. Phase 4에서 저장한 `product_feedback` + `learning_state` + `discovered_products.user_action` 데이터를 집계하여:
1. **선별(Selection)** — 내가 어떤 상품을 어떻게 분류했는지 조회
2. **통계(Statistics)** — 카테고리/컨텍스트/탐색 비율/거절 이유 등 수치화 + 주간 Gemini 인사이트

### 1.1 성공 기준
- `/analytics/discovery/insights` 페이지 작동
- ContextSubTabs에 "インサイト" 4번째 서브탭 추가 (ホーム / ライブ / 履歴 / インサイト)
- インサイト 내부 2단 탭 (選別 / 統計) 작동
- 選別 탭: 4가지 상태별 필터 + 기간 + context 필터로 제품 카드 그리드
- 統計 탭: KPI 4 카드 + Gemini 주간 요약 + 4 차트
- 매주 월요일 01:00 UTC weekly-insights cron 실행, Gemini 자연어 요약 생성

### 1.2 Out of Scope
- 제품별 상세 drill-down (클릭 시 기존 세션 상세 페이지로 이동)
- CSV export
- 실시간 업데이트 (페이지 로드 시점 snapshot)

---

## 2. 데이터 모델

### 2.1 `learning_insights` (Phase 1에서 이미 정의됨)

```sql
CREATE TABLE learning_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  created_at timestamptz DEFAULT now(),
  sourced_count int,
  rejected_count int,
  top_rejection_reasons jsonb,
  sourced_product_patterns text,
  exploration_wins text,
  next_week_suggestions text,
  UNIQUE (week_start)
);
```

**신규 변경**: Phase 4에서 context가 분리되었으므로, `context` 컬럼을 추가해 context별 주간 인사이트를 저장하도록 마이그레이션.

**마이그레이션** `supabase/migrations/2026-04-18_insights_context.sql`:
```sql
ALTER TABLE learning_insights
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));

-- UNIQUE 제약 변경: (week_start) → (week_start, context)
ALTER TABLE learning_insights DROP CONSTRAINT IF EXISTS learning_insights_week_start_key;
ALTER TABLE learning_insights ADD CONSTRAINT learning_insights_week_context_key
  UNIQUE (week_start, context);

CREATE INDEX IF NOT EXISTS idx_learning_insights_context
  ON learning_insights (context, week_start DESC);
```

### 2.2 조회 대상
- `product_feedback` (이벤트 로그, 30일 집계)
- `discovered_products` (user_action 현재 상태)
- `learning_state` (카테고리 가중치, 탐색 비율)
- `learning_insights` (주간 Gemini 요약)

---

## 3. API 엔드포인트

### 3.1 `GET /api/cron/weekly-insights`
- Schedule: 매주 월요일 01:00 UTC
- maxDuration: 120s
- 실행:
  1. 지난주 월-일 `product_feedback` + `discovered_products` 집계 (context별)
  2. Gemini에게 자연어 요약 요청 (각 context별 별도 호출)
  3. `learning_insights` 2 row UPSERT (home_shopping, live_commerce)
- CRON_SECRET 검증

### 3.2 `GET /api/discovery/insights?context=...&weeks=N`
- 최근 N주 `learning_insights` + 현재 `learning_state` + KPI 계산
- 응답:
  ```json
  {
    "kpi": {
      "thisWeekSourced": 12,
      "thisWeekRejected": 8,
      "explorationRatio": 0.52,
      "totalFeedback": 145
    },
    "weeklyInsights": [ /* learning_insights rows */ ],
    "categoryWeights": { /* from learning_state */ },
    "explorationTrend": [ /* [{week, ratio}, ...] */ ],
    "rejectionReasons": [ /* [{reason, count}, ...] */ ],
    "dailyFeedback": [ /* [{date, sourced, interested, rejected, duplicate}, ...] */ ]
  }
  ```

### 3.3 `GET /api/discovery/selections?status=...&context=...&from=...&to=...&page=N&limit=20`
- 필터링된 제품 카드 리스트 (페이지네이션)
- 응답: `{ products: [...], total: N, page: N }`

---

## 4. UI 구조

### 4.1 서브탭 추가 (`components/discovery/ContextSubTabs.tsx`)

현재 `ContextSubTabs`: ホーム / ライブ / 履歴 (3 tabs, orange active).
추가: **インサイト** (4th tab, same orange active, different icon BarChart3).

### 4.2 인사이트 페이지 (`app/[locale]/analytics/discovery/insights/page.tsx`)

Client component. 내부에 `<InsightsTabs />` 컴포넌트가 2단 탭 + 콘텐츠 전환 관리.

### 4.3 `InsightsTabs.tsx`

간단한 useState 기반 2개 버튼 + 조건부 렌더링:
- 選別 → `<SelectionGrid />`
- 統計 → `<StatsDashboard />`

### 4.4 선별 탭 — `SelectionGrid.tsx`

**필터 바** (상단):
- 상태: [全て | ソーシング済み | 関心あり | 却下 | 既にあり] (라디오 버튼 그룹)
- Context: [全て | ホーム | ライブ] 
- 기간: [7日 | 30日 | 90日] (기본 30)
- 정렬: action_at DESC

**그리드**:
- `ProductCard` 재사용 (기존 컴포넌트, 피드백 버튼 포함 → 상태 재변경도 여기서 가능)
- 2단 그리드 (lg 이상), 1단 (모바일)
- 20개/페이지, "もっと見る" 버튼으로 추가 로드

### 4.5 통계 탭 — `StatsDashboard.tsx`

**상단 KPI 카드 4개** (`KPICard.tsx`):
```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ ソーシング │ │ 却下     │ │ 探索比率 │ │ 総サンプル│
│   12     │ │    8     │ │  52%    │ │   145    │
│ 今週      │ │ 今週      │ │ 現在     │ │ 累計      │
└──────────┘ └──────────┘ └──────────┘ └──────────┘
```

**주간 인사이트 카드** (`WeeklyInsightCard.tsx`):
- 전주 대비 변화 표시
- Gemini 생성 3개 섹션: 하이라이트 / 成功パターン / 来週の提案
- context별 탭 (home/live 전환 가능)

**차트 4종 (recharts)**:
1. `CategorySourcingChart.tsx` — 카테고리별 소싱률 가로 막대, home/live 색상 구분
2. `DailyFeedbackChart.tsx` — 최근 30일 일별 sourced/rejected/interested/duplicate 스택 막대
3. `ExplorationTrendChart.tsx` — 최근 12주 exploration_ratio 꺾은선, home/live 2 라인
4. `RejectionReasonChart.tsx` — 거절 이유 도넛 차트, 상위 5 이유 + その他 그룹화

모든 차트는 `ResponsiveContainer` 사용.

### 4.6 i18n 키 (약 25개)

`messages/ja.json` + `en.json` discovery 블록에 추가:
```
subTabInsights: "インサイト" / "Insights"
insightsSelectionTab: "選別" / "Selection"
insightsStatsTab: "統計" / "Statistics"
kpiSourcedThisWeek: "今週のソーシング" / "Sourced (this week)"
kpiRejectedThisWeek: "今週の却下" / "Rejected (this week)"
kpiExplorationRatio: "探索比率" / "Exploration ratio"
kpiTotalSamples: "総サンプル" / "Total samples"
weeklyInsightTitle: "週間インサイト" / "Weekly Insights"
weeklyInsightHighlight: "ハイライト" / "Highlights"
weeklyInsightPatterns: "成功パターン" / "Success Patterns"
weeklyInsightSuggestions: "来週の提案" / "Next Week"
chartCategorySourcing: "カテゴリ別ソーシング率" / "Category Sourcing Rate"
chartDailyFeedback: "日別フィードバック" / "Daily Feedback"
chartExplorationTrend: "探索比率推移" / "Exploration Trend"
chartRejectionReasons: "却下理由分布" / "Rejection Reasons"
periodFilter7: "7日" / "7 days"
periodFilter30: "30日" / "30 days"
periodFilter90: "90日" / "90 days"
loadMore: (이미 있음) 
noData: "データなし" / "No data"
thisWeek: "今週" / "This week"
currentValue: "現在" / "Current"
cumulative: "累計" / "Cumulative"
weekOverWeek: "前週比" / "WoW"
```

---

## 5. Weekly insights Gemini 프롬프트

`lib/discovery/weekly-insights.ts`:

```typescript
export interface WeeklyInsightInput {
  weekStart: string;
  weekEnd: string;
  context: Context;
  sourcedCount: number;
  rejectedCount: number;
  topCategories: Array<{ category: string; sourced: number; shown: number }>;
  topRejectionReasons: Array<{ reason: string; count: number }>;
  explorationStats: { ratio: number; winRate: number };
  tvProvenStats: { winRate: number };
}

export interface WeeklyInsightOutput {
  sourced_product_patterns: string;  // Highlights + 成功パターン
  exploration_wins: string;           // 탐색 성공 케이스
  next_week_suggestions: string;      // 다음주 제안
}

export async function generateWeeklyInsight(
  input: WeeklyInsightInput
): Promise<WeeklyInsightOutput>;
```

Gemini 프롬프트 구조: 일본어로 입력 데이터 나열 → 3개 섹션 JSON 요청.

---

## 6. 파일 영향 요약

**신규**:
```
supabase/migrations/2026-04-18_insights_context.sql
app/api/cron/weekly-insights/route.ts
app/api/discovery/insights/route.ts
app/api/discovery/selections/route.ts
app/[locale]/analytics/discovery/insights/page.tsx
components/discovery/
  InsightsTabs.tsx
  SelectionGrid.tsx
  StatsDashboard.tsx
  KPICard.tsx
  WeeklyInsightCard.tsx
  charts/CategorySourcingChart.tsx
  charts/DailyFeedbackChart.tsx
  charts/ExplorationTrendChart.tsx
  charts/RejectionReasonChart.tsx
lib/discovery/weekly-insights.ts
```

**수정**:
```
components/discovery/ContextSubTabs.tsx   — "インサイト" 서브탭 추가
messages/ja.json, en.json                 — ~25 keys
vercel.json                               — cron + function timeout
package.json                              — recharts 설치
```

---

## 7. 결정 기록

| # | 결정 | 근거 |
|---|------|------|
| 1 | 서브탭 위치: 商品発掘 하위 | 발굴 관련 분석이라 발굴 컨텍스트 유지 |
| 2 | 2단 탭 (選別 / 統計) | 검토와 분석 목적 분리 |
| 3 | 통계 = KPI 4 + Gemini 카드 + 차트 4 | B옵션 선택 |
| 4 | recharts 채택 | shadcn 호환, React 19/Next 16 호환 확인 필요 |
| 5 | Cron: 월요일 01:00 UTC | 주말 피드백 반영 후 월요일 아침 확인 |
| 6 | learning_insights에 context 컬럼 추가 | Phase 4 context 분리와 일관성 |
| 7 | 선별 탭 페이지네이션 20개 | 대부분 사용자가 상위 몇 개만 확인 |
| 8 | ProductCard 재사용 | 피드백 수정 가능 (상태 재변경) |

---

## 8. Out-of-scope
- 카테고리별 drill-down
- Export 기능
- 실시간 WebSocket 업데이트
- Mobile responsive 최적화 (PC 우선)
