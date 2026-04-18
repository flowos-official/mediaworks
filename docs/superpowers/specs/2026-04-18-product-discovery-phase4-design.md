# Product Discovery Phase 4 — Feedback & Learning Design Spec

- **Date**: 2026-04-18
- **Author**: MediaWorks Engineering
- **Status**: Draft (awaiting user review)
- **Target**: Phase 4 — 피드백 수집 + daily-learning cron + 발굴 파이프라인 반영
- **Depends on**: Phase 1-3.5 완료 (context split, enrichment)
- **Out of scope**: Phase 5 (weekly insights + 차트 대시보드) — 다음 phase

---

## 1. 목적 (Goal)

사용자가 매일 발굴된 상품을 4가지 피드백 버튼(소싱/관심/거절/중복)으로 빠르게 분류하고, 그 피드백이 다음 날 발굴 결과에 자동 반영되는 학습 루프를 구축한다. 홈쇼핑과 라이브커머스 context를 독립적으로 학습하여 각자 최적화된다.

### 1.1 성공 기준
- 각 카드에 4버튼 + 거절 이유 모달이 표시되고, 클릭 시 즉시 저장된다.
- 토글: 같은 버튼 재클릭 시 상태 해제.
- 소싱/중복 클릭 시 해당 상품은 향후 발굴에서 영구 제외된다.
- 거절 클릭 시 해당 context의 `rejected_seeds` 에 URL + 브랜드 추가 (반대 context에는 영향 없음).
- 매일 23:45 UTC에 learning cron이 실행되어 `learning_state` 2 row (home/live)를 갱신.
- 다음 발굴 cron(00:00, 00:30 UTC)이 갱신된 learning_state를 사용.

### 1.2 범위 밖 (Out of Scope)
- Phase 5 기능: weekly-insights cron, `/analytics/discovery/insights` 대시보드, 차트 3종
- 수동 override UI (자동 학습 신뢰)
- 피드백 이력 조회 UI (`product_feedback` 이벤트 로그는 저장만)

---

## 2. 아키텍처 개요

```
[사용자 카드 클릭]
  └─ FeedbackButtons (4버튼) → POST /api/discovery/feedback
       ├─ product_feedback INSERT (이벤트 로그)
       └─ discovered_products UPDATE (user_action/reason/at)

[매일 23:45 UTC]
  └─ /api/cron/daily-learning
       for each context ∈ [home_shopping, live_commerce]:
         ├─ 최근 30일 product_feedback 집계 (context 필터)
         ├─ category_weights 계산
         ├─ rejected_seeds 추출 (URL + 브랜드)
         ├─ exploration_ratio 조정
         └─ learning_state UPSERT (context PK)

[매일 00:00 + 00:30 UTC]
  └─ /api/cron/daily-discovery-{home,live}
       ├─ loadLearningState(context) → 갱신된 값 사용
       ├─ loadExclusionContext(context) → sourced/duplicate + rejected_seeds 반영
       └─ 발굴 30개 저장
```

---

## 3. DB 변경

### 3.1 `learning_state` 재구조화 (단일 row → context별 2 row)

**현재 스키마**:
```sql
CREATE TABLE learning_state (
  id int PRIMARY KEY CHECK (id = 1),
  exploration_ratio numeric(3,2) DEFAULT 0.47,
  category_weights jsonb DEFAULT '{}',
  rejected_seeds jsonb DEFAULT '{"urls":[],"brands":[],"terms":[]}',
  recent_rejection_reasons jsonb DEFAULT '[]',
  feedback_sample_size int DEFAULT 0,
  is_cold_start boolean DEFAULT true,
  updated_at timestamptz DEFAULT now()
);
INSERT INTO learning_state (id) VALUES (1);
```

**목표 스키마**:
```sql
CREATE TABLE learning_state (
  context text PRIMARY KEY CHECK (context IN ('home_shopping', 'live_commerce')),
  exploration_ratio numeric(3,2) NOT NULL DEFAULT 0.47,
  category_weights jsonb NOT NULL DEFAULT '{}',
  rejected_seeds jsonb NOT NULL DEFAULT '{"urls":[],"brands":[],"terms":[]}',
  recent_rejection_reasons jsonb NOT NULL DEFAULT '[]',
  feedback_sample_size int NOT NULL DEFAULT 0,
  is_cold_start boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### 3.2 마이그레이션 SQL

**파일**: `supabase/migrations/2026-04-18_learning_per_context.sql`

```sql
-- Phase 4: split learning_state per context

-- Step 1: add context column as nullable
ALTER TABLE learning_state
  ADD COLUMN IF NOT EXISTS context text
    CHECK (context IN ('home_shopping', 'live_commerce'));

-- Step 2: assign existing row(s) to home_shopping
UPDATE learning_state SET context = 'home_shopping' WHERE context IS NULL;

-- Step 3: make context NOT NULL
ALTER TABLE learning_state ALTER COLUMN context SET NOT NULL;

-- Step 4: drop old PK + id column + CHECK (id = 1) constraint
ALTER TABLE learning_state DROP CONSTRAINT IF EXISTS learning_state_pkey;
ALTER TABLE learning_state DROP CONSTRAINT IF EXISTS learning_state_id_check;
ALTER TABLE learning_state DROP COLUMN IF EXISTS id;

-- Step 5: add new PK on context
ALTER TABLE learning_state ADD PRIMARY KEY (context);

-- Step 6: insert live_commerce row if not exists
INSERT INTO learning_state (context)
  VALUES ('live_commerce')
  ON CONFLICT (context) DO NOTHING;
```

### 3.3 변경 없음
- `product_feedback` — Phase 1 스키마 그대로 사용. context는 discovered_products join으로 필터.
- `discovered_products.user_action` / `action_reason` / `action_at` — 기존 컬럼 활용.

---

## 4. API

### 4.1 `POST /api/discovery/feedback`

**엔드포인트**: `app/api/discovery/feedback/route.ts`

**요청 body**:
```typescript
{
  productId: string;
  action: 'sourced' | 'interested' | 'rejected' | 'duplicate';
  reason?: '価格帯不適合' | 'カテゴリ過飽和' | '既に放送中' | '品質懸念' | 'その他';
  // reason required if action === 'rejected'
}
```

**동작**:
1. `discovered_products.user_action` 현재 값 조회
2. 동일 action이면 토글 해제 → user_action = NULL, reason = NULL
3. 다르면 덮어쓰기 → user_action = action, reason = reason ?? NULL, action_at = now()
4. `product_feedback` INSERT (이벤트 로그, 토글 해제 시 action='cleared' 로 기록? → **아니다**, 해제는 이벤트 로그 생략. 최신 상태가 NULL인 것으로 충분)
5. 응답: `{ ok: true, action: 현재_상태, user_action: null | action }`

**응답 예시**:
```json
{ "ok": true, "action": "toggled_off", "user_action": null }
{ "ok": true, "action": "set", "user_action": "sourced" }
```

**검증**:
- `action` 이 4가지 외면 400
- `action === 'rejected'` 인데 reason 없으면 400
- productId 존재 안 하면 404

**인증**: 내부 도구라 무인증 유지 (Phase 3.5 패턴 동일).

### 4.2 `GET /api/cron/daily-learning`

**엔드포인트**: `app/api/cron/daily-learning/route.ts`

**실행**:
- 매일 23:45 UTC (Vercel Cron)
- maxDuration: 60s
- CRON_SECRET 헤더 검증

**로직** (상세는 §5):
```typescript
for (const context of ['home_shopping', 'live_commerce']) {
  const stats = await computeContextLearning(context);
  await sb.from('learning_state').upsert({
    context,
    ...stats,
    updated_at: new Date().toISOString(),
  });
}
```

### 4.3 기존 API 유지
- `POST /api/discovery/manual-trigger` 변경 없음
- `GET /api/discovery/today?context=...` 변경 없음 (응답에 user_action/action_reason 이미 포함)
- `GET /api/discovery/enrich/[productId]` 변경 없음

---

## 5. 학습 파이프라인 상세

### 5.1 `lib/discovery/learning.ts`

**주요 함수**:

```typescript
export interface ContextLearningStats {
  exploration_ratio: number;
  category_weights: Record<string, number>;
  rejected_seeds: { urls: string[]; brands: string[]; terms: string[] };
  recent_rejection_reasons: Array<{ reason: string; count: number }>;
  feedback_sample_size: number;
  is_cold_start: boolean;
}

export async function computeContextLearning(
  context: Context,
): Promise<ContextLearningStats>;
```

### 5.2 집계 쿼리

**기간**: 최근 30일

```sql
SELECT 
  pf.action,
  pf.reason,
  pf.created_at,
  dp.category,
  dp.seller_name,
  dp.product_url,
  dp.track
FROM product_feedback pf
JOIN discovered_products dp ON dp.id = pf.discovered_product_id
WHERE dp.context = $1
  AND pf.created_at > now() - interval '30 days';
```

### 5.3 계산 로직

#### A. `feedback_sample_size`
피드백 이벤트 수 (deep_dive 포함).

#### B. `is_cold_start`
```typescript
feedback_sample_size < 10  // 쿨드 스타트 임계값
```
쿨드 스타트 시 다른 계산 건너뛰고 기본값 반환.

#### C. `category_weights` (카테고리별 승률)
```typescript
// 각 카테고리별:
// success_rate = (sourced_count + interested_count + deep_dive_count) / shown_count
// shown_count: 해당 카테고리의 discovered_products 총 수 (last 30d)
// 가중치 = success_rate (0.0 ~ 1.0)
// 샘플 수 < 5 카테고리는 0.5 기본값 사용
```

#### D. `rejected_seeds`
```typescript
const rejected = feedback.filter(f => f.action === 'rejected');
return {
  urls: unique(rejected.map(r => r.product_url)),
  brands: unique(rejected.map(r => r.seller_name).filter(Boolean)),
  terms: [],  // Phase 4에서는 빈 배열. Phase 5에서 Gemini로 공통 키워드 추출
};
```

#### E. `exploration_ratio` 조정
```typescript
const tvWinRate = successRate(track='tv_proven');
const expWinRate = successRate(track='exploration');
const current = existingRatio ?? 0.47;

let next = current;
if (expWinRate >= tvWinRate) next = Math.min(0.67, current + 0.05);
else if (expWinRate < tvWinRate - 0.1) next = Math.max(0.2, current - 0.05);

// 샘플 < 20 전체 시 current 유지 (안정화)
if (totalSamples < 20) next = current;
```

#### F. `recent_rejection_reasons`
```typescript
// rejected 중 reason별 count
// 상위 5개 → [{ reason, count }, ...]
```

### 5.4 `exclusion.ts` 확장

**변경 사항**: `loadExclusionContext(learning, context)` — context 파라미터 추가.

신규 기준 추가:
```typescript
// 5. 사용자가 명시적으로 제외한 상품 (영구 제외)
const { data: sourcedOrDup } = await sb
  .from('discovered_products')
  .select('product_url, rakuten_item_code, seller_name')
  .in('user_action', ['sourced', 'duplicate']);

// 결과:
ctx.sourcedProductUrls = new Set(sourcedOrDup.map(r => r.product_url));
ctx.sourcedRakutenCodes = new Set(sourcedOrDup.map(r => r.rakuten_item_code).filter(Boolean));
```

`applyExclusions` 에 추가 필터:
```typescript
if (ctx.sourcedProductUrls.has(item.productUrl)) return false;
if (item.rakutenItemCode && ctx.sourcedRakutenCodes.has(item.rakutenItemCode)) return false;
```

**rejected_seeds**: context별로 읽으므로 기존 `learning.rejected_seeds` 가 이미 해당 context 꺼. 로직 변경 불필요, 파라미터만 추가.

### 5.5 `orchestrator.ts` + cron 연결

**변경 사항**:
- `loadLearningState(context)` — row 하나만 로드 (PK = context)
- `daily-discovery-home/route.ts` → `loadLearningState('home_shopping')`
- `daily-discovery-live/route.ts` → `loadLearningState('live_commerce')`

---

## 6. UI

### 6.1 `FeedbackButtons.tsx` — 4버튼 row

**Location**: `components/discovery/FeedbackButtons.tsx`

```tsx
"use client";
import { CheckCircle2, Star, XCircle, Copy } from "lucide-react";
import { useState } from "react";

type Action = 'sourced' | 'interested' | 'rejected' | 'duplicate';
type Current = Action | null;

interface Props {
  productId: string;
  current: Current;
  onChange: (next: Current, reason?: string) => void;  // parent triggers API
  onRejectClick: () => void;                            // parent opens RejectDialog
}

const BUTTONS: Array<{ action: Action; icon: React.ReactNode; labelKey: string; activeColor: string }> = [
  { action: 'sourced', icon: <CheckCircle2 size={12} />, labelKey: 'sourceButton', activeColor: 'bg-green-500 text-white border-green-500' },
  { action: 'interested', icon: <Star size={12} />, labelKey: 'interestedButton', activeColor: 'bg-orange-500 text-white border-orange-500' },
  { action: 'rejected', icon: <XCircle size={12} />, labelKey: 'rejectedButton', activeColor: 'bg-red-500 text-white border-red-500' },
  { action: 'duplicate', icon: <Copy size={12} />, labelKey: 'duplicateButton', activeColor: 'bg-gray-500 text-white border-gray-500' },
];
```

**동작**:
- 비활성 버튼 클릭: action API 호출
- 활성 버튼 재클릭: toggle 해제 (action=null)
- 거절 버튼 클릭: onRejectClick() → parent가 RejectDialog 열기 → reason 선택 → onChange('rejected', reason)

### 6.2 `RejectDialog.tsx`

**Location**: `components/discovery/RejectDialog.tsx`

shadcn Dialog 컴포넌트 기반. 5개 라디오 옵션 + 확인/취소 버튼.

### 6.3 `ProductCard.tsx` 통합

FeedbackButtons를 액션 버튼 row의 **최상단**에 추가. 기존 "深掘り" 와 "拡大戦略" 버튼은 그 아래 유지.

거절 상태(user_action='rejected')인 카드:
- 전체 opacity 0.5
- "거절" 버튼만 활성 색상으로 강조
- 호버 시 reason tooltip 표시

### 6.4 i18n 추가

`messages/ja.json` / `en.json` discovery 블록에:
```json
"sourceButton": "ソーシング済み" / "Sourced",
"interestedButton": "関心あり" / "Interested",
"rejectedButton": "却下" / "Rejected",
"duplicateButton": "既にあり" / "Duplicate",
"rejectDialogTitle": "却下理由を選択" / "Select rejection reason",
"rejectReason_priceMismatch": "価格帯不適合" / "Price mismatch",
"rejectReason_categorySaturated": "カテゴリ過飽和" / "Category saturated",
"rejectReason_alreadyBroadcast": "既に放送中" / "Already broadcasting",
"rejectReason_qualityConcern": "品質懸念" / "Quality concern",
"rejectReason_other": "その他" / "Other",
"confirm": "確定" / "Confirm",
"cancel": "キャンセル" / "Cancel"
```

---

## 7. 운영

### 7.1 Cron 스케줄 (`vercel.json`)

추가:
```json
{ "path": "/api/cron/daily-learning", "schedule": "45 23 * * *" }
```

기존 유지:
- `/api/cron/daily-refresh` — 9 AM UTC
- `/api/cron/daily-discovery-home` — 0:00 UTC
- `/api/cron/daily-discovery-live` — 0:30 UTC

순서: **23:45 learning → 24:00 home → 24:30 live** (학습 결과가 당일 발굴에 반영)

### 7.2 함수 타임아웃

```json
"app/api/cron/daily-learning/route.ts": { "maxDuration": 60 },
"app/api/discovery/feedback/route.ts": { "maxDuration": 10 }
```

### 7.3 에러 처리
- Learning cron 실패 → `learning_state` 갱신 안 됨 → 다음 discovery cron은 기존 (어제 값) 사용. 서비스 중단 없음.
- Feedback API 실패 → 클라이언트 토스트 에러, 재시도 가능.

---

## 8. 파일 영향 요약

**신규**:
```
supabase/migrations/2026-04-18_learning_per_context.sql
app/api/discovery/feedback/route.ts
app/api/cron/daily-learning/route.ts
lib/discovery/learning.ts
components/discovery/FeedbackButtons.tsx
components/discovery/RejectDialog.tsx
```

**수정**:
```
lib/discovery/types.ts           — LearningState 기본값/DEFAULT_LEARNING_STATE 유지 (신규 row도 이 값으로)
lib/discovery/exclusion.ts       — sourced/duplicate 제외 추가, context 파라미터 (기존)
lib/discovery/orchestrator.ts    — loadLearningState(context)
lib/supabase.ts                  — LearningState row 타입 (context 필드 추가)
app/api/cron/daily-discovery-home/route.ts — learning load
app/api/cron/daily-discovery-live/route.ts — learning load
app/api/discovery/today/route.ts — (변경 없음, 응답에 이미 user_action 포함)
components/discovery/ProductCard.tsx — FeedbackButtons + RejectDialog 통합
messages/ja.json, messages/en.json — feedback 키 추가
vercel.json — daily-learning cron 추가
```

---

## 9. 결정 기록

| # | 결정 | 근거 |
|---|------|------|
| 1 | Phase 4 범위: 피드백 + 학습만 (Phase 5 인사이트 제외) | 데이터 쌓인 후 차트 설계가 의미 있음 |
| 2 | Context별 learning_state 완전 분리 | 홈/라이브 신호가 근본적으로 다름 |
| 3 | 피드백 버튼 4개 카드 top action row에 배치 | 발견성 + 즉각성 최우선 |
| 4 | 같은 버튼 재클릭 = 토글 해제 | 실수 복구 쉬움 |
| 5 | sourced/duplicate → 영구 발굴 제외 | 사용자가 명시적으로 처리 완료한 상품 |
| 6 | rejected → rejected_seeds에 URL + seller_name 추가 (해당 context만) | 반대 context에는 영향 없어야 함 |
| 7 | 거절 이유 5가지 고정 라디오 | 학습 분류 단순화 |
| 8 | daily-learning cron 23:45 UTC | discovery cron (0:00/0:30) 직전 실행 |
| 9 | 쿨드 스타트 = context별 10건 | 분리했으니 임계값도 낮춤 (30→10→절반) |
| 10 | recent_rejection_reasons 상위 5 | curate 프롬프트에 hint로 주입 (기존 Phase 1 패턴) |
| 11 | deep_dive (암묵 관심) 는 category_weights에만 반영 | 학습 루프에서 명시 버튼과 구분 |
| 12 | 피드백 UI에 '미검토로' 별도 버튼 없음 | 토글 방식이 충분 |
| 13 | 거절 카드 opacity 0.5 dim | 시각적 상태 표현 |

---

## 10. 오픈 이슈

없음. 모든 결정 항목 해소.
