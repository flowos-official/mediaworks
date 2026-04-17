# Product Discovery Redesign — Design Spec

- **Date**: 2026-04-18
- **Author**: MediaWorks Engineering
- **Status**: Draft (awaiting user review)
- **Target**: Full redesign of the daily product-discovery pipeline (approach B+C)

---

## 1. 목적 (Goal)

미디어웍스(일본 내 제품을 소싱해 일본 홈쇼핑/라이브커머스 채널에 공급하는 회사)를 위해, **매일 자동으로 30개의 소싱 가능한 신제품 후보를 발굴하는 시스템**을 구축한다.

### 1.1 성공 기준
- 매일 09:00 JST에 30개 후보가 `discovered_products` 테이블에 저장되어 있다.
- 각 후보는 B 패키지(제품명, 썸네일, 가격, 리뷰, 판매자, 재고, TV 적합성, 경쟁사 방송 태그)를 모두 포함한다.
- 사용자가 "깊이 파기" 클릭 시 60초 이내 C 패키지(제조사, 도매 추정, MOQ, TV 스크립트, SNS 트렌드)가 비동기 생성된다.
- 자사 소싱 이력(`product_summaries`) 및 최근 7일 추천은 자동 제외된다.
- 사용자 피드백(4버튼 + deep-dive 클릭)이 다음 발굴의 카테고리 가중치/탐색 비율/거절 시드에 반영된다.

### 1.2 범위 밖 (Out of Scope)
- 한국 시장 확장 (일본 내수만 대상)
- 알리바바/1688 OEM 소싱 파이프라인
- Slack/이메일 실패 알림 (Phase 2)
- 사용자 로그인/RLS (내부 도구로 간주)
- `/api/recommend` 및 `/api/cron/daily-refresh` 제거 (당분간 유지)

---

## 2. 사업적 맥락 (Business Context)

- **미디어웍스 포지션**: 일본 홈쇼핑 채널(QVC Japan, Japanet, ショップチャンネル 등)에 상품을 제안/공급하는 소싱 회사.
- **의사결정자**: 사용자 1인 직접 검토. 아침 약 1시간 내 30개 검토 가능해야 함.
- **핵심 리스크**: 추천된 제품이 실제로 (a) 소싱 가능하지 않거나 (b) 이미 자사가 다룬 제품이거나 (c) 매일 동일 후보만 반복되면 시스템 가치가 0이 됨. 현재 코드의 주요 결함.

---

## 3. 아키텍처 개요 (Architecture Overview)

3-stage 파이프라인 + 선택적 에이전트 오케스트레이션:

```
[Stage 1 · Discovery] 00:00 UTC / 09:00 JST 일일 cron
  ├─ Gemini category plan (bounded-agent, 최대 3 iteration)
  ├─ Rakuten Search/Ranking + Brave Search
  ├─ Exclusion filters (own sourcing, 7-day history, rejection seeds)
  ├─ Gemini curation → 30 candidates
  └─ Competitor broadcast tagging (Brave × 30 병렬)

[Stage 2 · Enrichment] On-demand 비동기 (사용자 "깊이 파기" 클릭)
  └─ Gemini tool-calling agent: Rakuten seller → manufacturer → B2B 보강

[Stage 3 · Learning]
  ├─ Daily learning cron (23:50 UTC): feedback 집계 → learning_state 갱신
  └─ Weekly insights cron (월 01:00 UTC): Gemini 자연어 요약
```

### 3.1 에이전트 적용 원칙
- **Stage 1**: bounded agent. pool 품질이 낮으면 재질의하되 iteration 상한(3회) 엄수.
- **Stage 2**: full tool-calling agent. on-demand이므로 timeout 여유 (60초).
- **Stage 3 weekly**: 배치 Gemini. 서비스 경로 아님.

### 3.2 기존 시스템과의 경계
- `/api/recommend` — 수동 추천 용도로 유지.
- `/api/cron/daily-refresh` — 기존 업로드 제품 재분석 유지.
- `lib/md-strategy.ts` 의 `discoverNewProducts()` — **deprecated**. 신규 `lib/discovery/*` 가 대체.

---

## 4. Stage 1 — Discovery Pipeline

### 4.1 실행 타이밍
- Cron: `0 0 * * *` (매일 00:00 UTC = 09:00 JST)
- Endpoint: `GET /api/cron/daily-discovery`
- 보호: Vercel Cron 자동 `Authorization: Bearer <CRON_SECRET>` 헤더 검증.

### 4.2 파이프라인 단계

#### 단계 1 — 세션 시작
`discovery_sessions` INSERT (status='running', target_count=30, started_at=now()).

#### 단계 2 — 카테고리 플랜 수립 (Gemini 1회)
- 입력:
  - `product_summaries` TV 실적 상위 20 카테고리
  - `learning_state.category_weights` (콜드 스타트 시 null)
  - 지난 7일 `discovery_sessions.category_plan` (최근 사용 카테고리)
  - `learning_state.exploration_ratio` (초기 0.47 = 7/15)
- 출력: 15개 키워드
  - TV-proven 8개 (탐색 비율 7/15 반영 시)
  - Exploration 7개 (TV 실적 없는 트렌드 카테고리)
- 탐색 비율은 학습 결과에 따라 12:3 ~ 5:10 범위에서 동적 조정.

#### 단계 3 — Pool 빌드
- **Rakuten**: 키워드 15개 × 상위 10개 (리뷰순 Search → 실패 시 Ranking API 폴백). 1초 간격 순차.
- **Brave Search**: 키워드 15개 × 트렌드 쿼리 (`${kw} 通販 おすすめ 楽天 Amazon`). 병렬.
- 최대 pool: ~225개 (실제 필터 후 120-180 예상).

#### 단계 4 — 제외 필터
```
for each pool item:
  if fuzzy_match(name, product_summaries.name): EXCLUDE  -- 자사 소싱 이력
  if exists in discovered_products WHERE created_at > now()-7d: EXCLUDE
  if url in learning_state.rejected_seeds.urls: EXCLUDE
  if brand in learning_state.rejected_seeds.brands: EXCLUDE
  if any(term in name for term in learning_state.rejected_seeds.terms): EXCLUDE
  if rakuten_item_code exists in discovered_products (any date): EXCLUDE  -- 교차 세션 dedup
```

#### 단계 5 — 초기 큐레이션 (Gemini 1차)
- 입력: 필터 통과한 pool (예상 100-150개) + TV 적합성 기준 + `learning_state.recent_rejection_reasons`
- 점수 기준 (기존 `lib/md-strategy.ts:811-819` 계승 + 개선):
  - Rakuten 리뷰수/평점 (0-35)
  - TV 카테고리 일치 (0-20)
  - 일본 시장 트렌드 (0-15)
  - 가격대 적합성 (0-15, ¥3,000-30,000 선호)
  - 선물 수요/충동구매 신호 (0-15)
- 출력: 상위 40개 후보 + 각 점수 breakdown.

#### 단계 6 — 품질 게이트 (Bounded Agent)
```
if count(score >= 60) < 20 AND iterations < 3:
  Gemini: "부족한 카테고리 분석 → 추가 키워드 3개 제안"
  Rakuten/Brave 추가 호출 → pool 보강
  재큐레이션
else:
  break
```
- 최대 3 iteration 후에도 30개 미만이면 있는 만큼 진행 (`status='partial'`).

#### 단계 7 — 경쟁사 방송 체크 (30 병렬)
- 각 후보마다 Brave 쿼리: `"${product_name}" (QVCジャパン OR ジャパネット OR ショップチャンネル) 放送`
- Gemini (1회 배치 판정) → 각 후보에 `broadcast_tag` 부여:
  - `broadcast_confirmed` — 명시적 방송 증거
  - `broadcast_likely` — 간접 신호
  - `unknown` — 증거 없음
- **주의**: 태그만 부여. 제외 기준 아님.

#### 단계 8 — B 패키지 조립 + 저장
`discovered_products` INSERT × 30 (status='candidate', user_action=NULL).
`discovery_sessions` UPDATE (status='completed'|'partial', completed_at, produced_count, iterations).

### 4.3 에러 처리
- 각 단계 독립 try/catch. 부분 실패 시 남은 단계 최선 진행.
- plan 실패 → 기본 카테고리 10개 폴백.
- Rakuten 실패 → Brave만으로 진행.
- curate 실패 → Gemini 재시도 × 2, 최종 실패 시 `session.status='failed'`.
- 저장 실패 → 전체 재시도 × 1.

### 4.4 타임아웃 예산
| 단계 | 정상 | 최악 |
|------|------|------|
| Plan | 5s | 15s |
| Pool | 30s | 60s |
| Filter | 2s | 5s |
| Curate | 15s | 30s |
| Iteration × 2 | 0s | 90s |
| Broadcast | 30s | 45s |
| Save | 3s | 10s |
| **합계** | **~85s** | **~255s** |

Vercel 300초 타임아웃 내 여유.

### 4.5 파일 구조
```
app/api/cron/daily-discovery/route.ts    -- 진입점, 오케스트레이터
lib/discovery/
  pipeline.ts         -- 단계 1-8 함수
  plan.ts             -- 카테고리 플랜
  pool.ts             -- Rakuten + Brave 호출
  exclusion.ts        -- 제외 필터 3종
  curate.ts           -- Gemini 큐레이션
  orchestrator.ts     -- bounded agent iteration
  broadcast.ts        -- 경쟁사 체크
  save.ts             -- discovered_products 저장
  types.ts            -- TypeScript 타입
```

---

## 5. Stage 2 — Enrichment Agent

### 5.1 트리거 & 실행 방식
- 사용자 클릭 `POST /api/discovery/enrich/[productId]`
- 202 Accepted 즉시 반환 `{ productId, status: 'queued' }`
- 서버는 `discovered_products.enrichment_status='queued'` UPDATE 후 Vercel `waitUntil()` + 내부 fetch 로 worker 호출.
- Worker: `POST /api/discovery/enrich/[productId]/worker` (내부 전용, CRON_SECRET 검증)
- 클라이언트는 `GET /api/discovery/enrich/[productId]` 2초 간격 폴링.

### 5.2 에이전트 구성
- 모델: Gemini 3-Flash (tool-calling)
- 최대 tool call: 8회
- 최대 실행 시간: 55초 (vercel.json maxDuration=60)

### 5.3 제공 도구 (tools)
| Tool | 구현 | 용도 |
|------|------|------|
| `fetch_rakuten_page(url)` | `lib/discovery/tools/rakuten-page.ts` | 판매자 페이지 크롤링 (店舗名/会社名/所在地) |
| `search_brave(query)` | 기존 `lib/brave.ts` 재사용 | 제조사명으로 추가 검색 |
| `extract_manufacturer(html)` | `lib/discovery/tools/extract-manufacturer.ts` | 제품 페이지 "メーカー/製造元" 추출 |
| `fetch_url_meta(url)` | `lib/discovery/tools/fetch-meta.ts` | 제조사 공식사이트 title/description/연락처 추출 |
| `estimate_wholesale(retail, category)` | `lib/discovery/tools/estimate-wholesale.ts` | 도매가/마진 추정 |
| `generate_tv_script(product)` | `lib/discovery/tools/tv-script.ts` | TV 방송 스크립트 초안 |

### 5.4 도매가 추정 (Wholesale Rules)
- 파일: `lib/discovery/wholesale-rules.ts`
- 구성:
  - `baseline`: 카테고리별 일본 홈쇼핑 업계 평균 마진율 (초기값 하드코딩)
  - `mediaworks_adjust`: `product_summaries` 에서 카테고리별 실제 마진율 집계 (SQL 쿼리로 런타임 조회, 5분 캐시)
- 산식: `wholesale = retail × (1 - blended_margin_rate)` where `blended = 0.6*baseline + 0.4*mediaworks` (mediaworks 데이터 ≥ 3건일 때만)
- `confidence`: 샘플 수 기반 (high: ≥10건, medium: 3-9건, low: <3건 또는 baseline만)

### 5.5 에이전트 프롬프트
```
ROLE: You assist a Japanese home-shopping sourcing company to enrich a product with sourcing intelligence.

GOAL: Produce a C-package JSON with: manufacturer info, wholesale estimate, MOQ hint, TV script (JP), SNS trend signal.

PROCESS:
1. Call fetch_rakuten_page(url) to identify seller.
2. Decide: is seller the manufacturer? Signals: 会社名 contains メーカー/製造, official site exists, business description mentions 製造.
3. If seller = manufacturer: extract contact hints. Set confidence='high'.
4. If seller ≠ manufacturer: call extract_manufacturer(product_html) + search_brave to find true manufacturer. Confidence='medium'.
5. If neither works: confidence='low', return seller info as fallback.
6. Call estimate_wholesale(retail, category).
7. Call generate_tv_script(product_info).
8. Return complete C-package JSON.

CONSTRAINTS:
- Max 8 tool calls.
- Never fabricate contacts. If unknown, return null with confidence='low'.
- All natural-language output in Japanese.
```

### 5.6 C 패키지 스키마 (jsonb)
```json
{
  "manufacturer": {
    "name": "string | null",
    "is_seller_same_as_manufacturer": "bool",
    "official_site": "url | null",
    "address": "string | null",
    "contact_hints": ["email", "phone"],
    "confidence": "high | medium | low"
  },
  "wholesale_estimate": {
    "retail_jpy": "int",
    "estimated_cost_jpy": "int",
    "estimated_margin_rate": "number",
    "method": "baseline | blended | mediaworks_adjusted",
    "confidence": "high | medium | low"
  },
  "moq_hint": "string | null",
  "tv_script_draft": "string (JP, ~30s)",
  "sns_trend": {
    "signal_strength": "high | medium | low | none",
    "sources": ["tiktok", "instagram", ...]
  },
  "enriched_at": "timestamptz",
  "tool_calls_used": "int",
  "partial": "bool  // true if timeout hit before complete"
}
```

### 5.7 에러 처리
- Tool 개별 실패: confidence 낮춤 + 다른 경로 시도.
- Timeout 55초 도달: 현재까지 확보한 정보로 `partial=true` 저장.
- 완전 실패: `enrichment_status='failed'`, `enrichment_error` 텍스트 기록.

### 5.8 캐시
- `discovered_products.c_package` 저장 후 같은 productId 재요청 시 즉시 반환 (재생성 없음).
- "재분석" 강제 플래그는 초기 범위 밖.

---

## 6. Stage 3 — Feedback & Learning

### 6.1 피드백 수집

| 행동 | 기록 |
|------|------|
| "소싱함" | `product_feedback` INSERT action='sourced' + `discovered_products.user_action='sourced'` |
| "관심" | action='interested' |
| "거절" + 이유 | action='rejected', reason ∈ {가격대부적합, 카테고리포화, 이미방송중, 품질우려, 기타} |
| "이미 있음" | action='duplicate' |
| "깊이 파기" 클릭 | action='deep_dive' (암묵) + enrichment 트리거 |

- `discovered_products.user_action` — 최신 상태.
- `product_feedback` — 이벤트 히스토리 (상태 전이 보존).

### 6.2 일일 학습 cron
- Endpoint: `GET /api/cron/daily-learning`
- Schedule: `50 23 * * *` (23:50 UTC, 다음 discovery cron 10분 전)
- 입력: 최근 30일 `product_feedback`
- 산출물 (단일 row UPSERT `learning_state` id=1):
  - **`category_weights`** (jsonb):
    - 카테고리별 승률 = (sourced + interested + deep_dive) / shown
    - 샘플 수 < 5 카테고리는 기본값 0.5
  - **`rejected_seeds`** (jsonb):
    - action='rejected' 제품의 URL, 브랜드명, 공통 키워드 (Gemini 추출 불필요, 단순 집계)
  - **`exploration_ratio`**:
    - exploration track 승률 vs tv_proven track 승률 비교
    - 탐색 승률 ≥ TV 승률: ratio += 0.05 (최대 0.67 = 10/15)
    - 탐색 승률 < TV 승률 - 0.1: ratio -= 0.05 (최소 0.2 = 3/15)
    - 샘플 수 < 20 전체: 기본값 0.47 유지 (콜드 스타트)
  - **`recent_rejection_reasons`** (jsonb): 상위 5개 이유 + count
  - **`is_cold_start`**: feedback_sample_size < 20
- 실행 시간: ~5-10초 예상.

### 6.3 주간 인사이트 cron
- Endpoint: `GET /api/cron/weekly-insights`
- Schedule: `0 1 * * 1` (월요일 01:00 UTC)
- 입력: 지난주 월-일 `product_feedback` + `discovered_products`
- Gemini 프롬프트: 자연어 분석 요청
  - 거절 이유 상위 3개 + 추정 원인
  - 소싱된 제품의 공통 특성
  - 탐색 카테고리 승률 순위
  - 다음 주 전략 제안
- 출력: `learning_insights` INSERT
- 12주 이전 row 자동 삭제.

### 6.4 학습의 발굴 파이프라인 반영
| 반영 지점 | 방식 |
|----------|------|
| 단계 2 카테고리 플랜 | Gemini에게 `category_weights` + `recent_rejection_reasons` 주입 |
| 단계 4 제외 필터 | `rejected_seeds.urls/brands/terms` 하드 제외 |
| 단계 5 큐레이션 | 프롬프트에 "지난 주 거절 이유 Top 3" 주입 → 해당 특성 감점 |
| 단계 6 iteration | 현재 `exploration_ratio` 사용 |

### 6.5 콜드 스타트
- `is_cold_start=true` 동안 기본값 (ratio=0.47, 가중치 균등, 거절 시드 없음).
- 피드백 ≥ 20 도달 시 첫 학습 주기부터 적용.

### 6.6 사용자 투명성
- `/discovery/insights` 페이지에 현재 `learning_state` 요약 + 최근 12주 `learning_insights`.
- **수동 override 없음** (결정: 자동 학습 신뢰).

---

## 7. 데이터 모델 (DB Schema)

### 7.1 `discovery_sessions`
```sql
CREATE TABLE discovery_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  status text CHECK (status IN ('running','completed','partial','failed')),
  target_count int DEFAULT 30,
  produced_count int DEFAULT 0,
  category_plan jsonb,
  exploration_ratio numeric(3,2),
  iterations int DEFAULT 0,
  error text
);
CREATE INDEX idx_discovery_sessions_run_at ON discovery_sessions (run_at DESC);
```

### 7.2 `discovered_products`
```sql
CREATE TABLE discovered_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES discovery_sessions(id),
  created_at timestamptz DEFAULT now(),

  name text NOT NULL,
  name_normalized text NOT NULL,
  thumbnail_url text,
  product_url text NOT NULL,
  price_jpy int,
  category text,
  source text CHECK (source IN ('rakuten','brave','other')),
  rakuten_item_code text,
  review_count int,
  review_avg numeric(2,1),
  seller_name text,
  stock_status text,

  tv_fit_score int CHECK (tv_fit_score BETWEEN 0 AND 100),
  tv_fit_reason text,
  broadcast_tag text CHECK (broadcast_tag IN ('broadcast_confirmed','broadcast_likely','unknown')),
  broadcast_sources jsonb,

  track text CHECK (track IN ('tv_proven','exploration')),
  is_tv_applicable boolean DEFAULT true,
  is_live_applicable boolean DEFAULT false,

  enrichment_status text DEFAULT 'idle' CHECK (enrichment_status IN ('idle','queued','running','completed','failed')),
  enrichment_started_at timestamptz,
  enrichment_completed_at timestamptz,
  c_package jsonb,
  enrichment_error text,

  user_action text CHECK (user_action IN ('sourced','interested','rejected','duplicate')),
  action_reason text,
  action_at timestamptz,

  UNIQUE (session_id, product_url)
);
CREATE INDEX idx_dp_created_at ON discovered_products (created_at DESC);
CREATE INDEX idx_dp_user_action ON discovered_products (user_action);
CREATE INDEX idx_dp_name_normalized ON discovered_products (name_normalized);
CREATE INDEX idx_dp_rakuten_item_code ON discovered_products (rakuten_item_code) WHERE rakuten_item_code IS NOT NULL;
CREATE INDEX idx_dp_enrichment_status ON discovered_products (enrichment_status);
```

### 7.3 `product_feedback`
```sql
CREATE TABLE product_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_product_id uuid NOT NULL REFERENCES discovered_products(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('sourced','interested','rejected','duplicate','deep_dive')),
  reason text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_pf_created_at ON product_feedback (created_at DESC);
CREATE INDEX idx_pf_action ON product_feedback (action);
CREATE INDEX idx_pf_product ON product_feedback (discovered_product_id);
```

### 7.4 `learning_state`
```sql
CREATE TABLE learning_state (
  id int PRIMARY KEY CHECK (id = 1),
  updated_at timestamptz DEFAULT now(),
  exploration_ratio numeric(3,2) DEFAULT 0.47,
  category_weights jsonb DEFAULT '{}'::jsonb,
  rejected_seeds jsonb DEFAULT '{"urls":[],"brands":[],"terms":[]}'::jsonb,
  recent_rejection_reasons jsonb DEFAULT '[]'::jsonb,
  feedback_sample_size int DEFAULT 0,
  is_cold_start boolean DEFAULT true
);
INSERT INTO learning_state (id) VALUES (1);
```

### 7.5 `learning_insights`
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
CREATE INDEX idx_li_week_start ON learning_insights (week_start DESC);
```

### 7.6 마이그레이션 파일
`supabase/migrations/2026-04-18_discovery_system.sql` (Supabase Studio에서 수동 실행).

### 7.7 RLS
- 내부 도구. RLS 비활성화.
- API 서버는 `SUPABASE_SERVICE_ROLE_KEY` 로만 접근.

---

## 8. API 엔드포인트

### 8.1 Cron
| Method | Path | 목적 | Timeout |
|--------|------|------|---------|
| GET | `/api/cron/daily-discovery` | Stage 1 실행 | 300s |
| GET | `/api/cron/daily-learning` | Stage 3 일일 학습 | 60s |
| GET | `/api/cron/weekly-insights` | Stage 3 주간 분석 | 120s |

### 8.2 사용자 API
| Method | Path | 목적 | 응답 |
|--------|------|------|------|
| GET | `/api/discovery/today` | 최신 세션의 30개 제품 | `{ session, products[], learning_summary }` |
| GET | `/api/discovery/sessions` | 세션 목록 (네비) | `{ sessions[] }` |
| GET | `/api/discovery/sessions/[id]` | 특정 세션 상세 | `{ session, products[] }` |
| POST | `/api/discovery/enrich/[productId]` | enrichment 트리거 | `202 { productId, status:'queued' }` |
| GET | `/api/discovery/enrich/[productId]` | enrichment 상태 폴링 | `{ status, c_package? }` |
| POST | `/api/discovery/enrich/[productId]/worker` | 내부 worker (CRON_SECRET) | `{ ok: true }` |
| POST | `/api/discovery/feedback` | 피드백 기록 | `{ ok: true }` |
| GET | `/api/discovery/insights` | 학습 리포트 데이터 | `{ state, insights[] }` |
| POST | `/api/discovery/manual-trigger` | discovery 수동 재실행 (관리자) | `{ session_id }` |

### 8.3 `vercel.json` 갱신
```json
{
  "crons": [
    { "path": "/api/cron/daily-discovery", "schedule": "0 0 * * *" },
    { "path": "/api/cron/daily-learning", "schedule": "50 23 * * *" },
    { "path": "/api/cron/weekly-insights", "schedule": "0 1 * * 1" }
  ],
  "functions": {
    "app/api/cron/daily-discovery/route.ts": { "maxDuration": 300 },
    "app/api/cron/daily-learning/route.ts": { "maxDuration": 60 },
    "app/api/cron/weekly-insights/route.ts": { "maxDuration": 120 },
    "app/api/discovery/enrich/[productId]/worker/route.ts": { "maxDuration": 60 }
  }
}
```

### 8.4 환경 변수 (신규)
- `CRON_SECRET` — cron 보호 (Vercel 자동 헤더)
- `DISCOVERY_TARGET_COUNT=30`
- `DISCOVERY_MAX_ITERATIONS=3`
- `DISCOVERY_EXPLORATION_INIT=0.47`

기존 재사용: `GEMINI_API_KEY`, `RAKUTEN_APP_ID`, `BRAVE_SEARCH_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

---

## 9. UI 설계

### 9.1 라우트
```
app/[locale]/discovery/
  page.tsx                    -- 오늘의 발굴 (메인)
  [sessionId]/page.tsx        -- 과거 세션
  insights/page.tsx           -- 학습 리포트
```
홈 페이지(`app/[locale]/page.tsx`) 상단에 "오늘의 발굴 30건" 진입 배너 추가.

### 9.2 메인 `/discovery`
- **상단 배너**: 날짜 / 세션 상태 / 탐색 비율 / 미검토·관심·소싱 카운트
- **네비 탭**: [오늘] [세션 히스토리] [학습 리포트]
- **필터 바**: 상태 필터 (전체/미검토/관심/소싱함/거절) + 정렬 (점수↓/가격↓)
- **스크롤 리스트**: 30개 카드를 한 페이지에 연속 스크롤 (페이지네이션 없음)

### 9.3 카드 (B 패키지)
```
┌────────┬──────────────────────────────────────────┐
│ 썸네일  │ 제품명 (일본어, 2줄 줄임)                  │
│ 120×120│ ¥4,980 · ★4.5(237건)          [tv_fit 87]│
│        │ 판매자: 〇〇店 · 재고 ○                   │
│        │ 🏷 TV 실적 / 🧭 탐색                      │
│        │ ⚠ broadcast_likely (증거 링크)           │
│        │ ── TV 적합 설명 2줄 ──                    │
├────────┴──────────────────────────────────────────┤
│ [🔍 깊이 파기] [✅ 소싱] [⭐ 관심] [❌ 거절] [🗑 중복] │
└───────────────────────────────────────────────────┘
```

### 9.4 깊이 파기 상태
- `idle`: 버튼 활성
- `queued`/`running`: 버튼에 스피너 + "제조사 추적 중..." (2초 간격 폴링)
- `completed`: "상세 보기"로 전환, 클릭 시 C 패키지 drawer

### 9.5 C 패키지 Drawer
- 제조사 블록: 이름/주소/공식사이트/연락처 힌트/confidence 배지
- 도매/마진 블록: 추정 도매가/마진율/산식/confidence
- MOQ 힌트
- TV 스크립트: 텍스트 + 복사/편집 버튼
- SNS 트렌드: 신호 강도 + 소스 태그

### 9.6 거절 모달
- 라디오 5개: `가격대부적합` / `카테고리포화` / `이미방송중` / `품질우려` / `기타`
- "기타" 선택 시 자유 입력 (저장되지만 학습에 미사용)
- 확인 시 `POST /api/discovery/feedback`

### 9.7 학습 리포트 `/discovery/insights`
- **상단**: 현재 `learning_state` 요약
  - 탐색 비율 (현재 + 추세)
  - 콜드 스타트 상태 표시
  - 거절 시드 수
- **차트 3종 (recharts)**:
  - 최근 4주 카테고리별 소싱률 (막대)
  - 탐색 비율 추세 (꺾은선)
  - 거절 이유 분포 (파이)
- **주간 인사이트 목록**: 최근 12주, 접을 수 있는 카드

### 9.8 컴포넌트 파일
```
components/discovery/
  DiscoveryHeader.tsx
  DiscoveryFilters.tsx
  ProductCard.tsx
  ProductCardActions.tsx
  EnrichmentProgress.tsx
  CPackageDrawer.tsx
  RejectDialog.tsx
  SessionCalendar.tsx
  InsightsDashboard.tsx
  charts/CategoryBarChart.tsx
  charts/ExplorationLineChart.tsx
  charts/RejectionPieChart.tsx
```

### 9.9 i18n
- 기존 `next-intl` 패턴 유지.
- `messages/ja.json`, `messages/en.json` 에 `discovery.*` 키 추가.
- 제품 설명/스크립트 본문은 **항상 일본어** (시장 타겟).

### 9.10 모바일
- PC 우선. 모바일은 동일 레이아웃 세로 스택, 추가 작업 없음.

### 9.11 차트 라이브러리
- 설치: `recharts` (약 80KB gz)
- React 19 / Next 15 호환 확인.

---

## 10. 운영

### 10.1 에러 & 복구
- 모든 단계 독립 try/catch, 부분 실패 허용.
- 실패 세션은 `discovery_sessions.status='failed'` + `error` 텍스트 기록.
- `/api/discovery/manual-trigger` 로 관리자 재실행 가능.
- 알림(Slack/이메일)은 Phase 2.

### 10.2 비용 예상 (월간)
| 항목 | 월간 비용 |
|------|----------|
| Rakuten API | 무료 (4,500 호출) |
| Brave Search (3,600 호출) | ~$7 |
| Gemini 3-Flash (~4.2M 토큰) | ~$5-10 |
| **합계** | **~$12-18/월** |

### 10.3 관찰 (Observability)
- `discovery_sessions.status`, `error`, `iterations` 로 cron 건전성 추적.
- `/discovery/insights` 에 최근 세션 성공률 표시.
- Vercel Function logs 에서 타임아웃/실패 확인.

---

## 11. 테스트

프로젝트에 테스트 프레임워크 없음. 최소 검증 장치:

- **타입 검증**: `npx tsc --noEmit` 모든 빌드 전 필수.
- **Dry-run 스크립트**: `scripts/test-discovery-dry-run.ts`
  - Stage 1 파이프라인을 DB 저장 없이 실행
  - pool 구성, 필터 결과, 큐레이션 출력을 콘솔에 덤프
  - `npm run test:discovery-dry-run` 스크립트로 호출
- **Enrichment dry-run**: `scripts/test-enrich-dry-run.ts`
  - 특정 URL 입력 → tool 호출 시퀀스 + C 패키지 출력
- **프로덕션 카나리아**: Phase 6 에서 매일 1주간 dry-run → 실제 저장 전환.

---

## 12. 단계별 롤아웃 (4주)

### Phase 1 — 기반 (Week 1)
- DB 스키마 SQL 작성 + Supabase Studio 수동 실행
- `lib/discovery/types.ts`, `exclusion.ts`, `pool.ts`, `plan.ts`, `curate.ts`
- `scripts/test-discovery-dry-run.ts`
- `npx tsc --noEmit` 통과 확인

### Phase 2 — 저장·조회 (Week 1-2)
- `save.ts`, `broadcast.ts`, `orchestrator.ts`
- `/api/cron/daily-discovery` 엔드포인트
- `/api/discovery/today`, `/api/discovery/sessions`
- `/discovery/page.tsx` + `ProductCard.tsx` (B 패키지, 피드백 버튼 없이)
- Cron 수동 트리거로 실제 30개 저장 검증

### Phase 3 — Enrichment (Week 2)
- `lib/discovery/tools/*.ts`, `enrich-agent.ts`, `wholesale-rules.ts`
- `/api/discovery/enrich/[productId]` (POST/GET) + worker
- `CPackageDrawer.tsx`, `EnrichmentProgress.tsx`
- 5-10개 샘플로 enrichment 정확도 수동 검증

### Phase 4 — 피드백 루프 (Week 2-3)
- `product_feedback` 테이블 활성화
- 4버튼 + `RejectDialog`
- `POST /api/discovery/feedback`
- `/api/cron/daily-learning`
- `learning_state` 업데이트 및 발굴에 반영 검증

### Phase 5 — 학습 리포트 (Week 3)
- `recharts` 설치
- `/api/cron/weekly-insights`
- `/discovery/insights` 페이지 + 차트 3종
- `InsightsDashboard` 컴포넌트

### Phase 6 — 안정화 (Week 3-4)
- 1주 프로덕션 운영, 프롬프트 튜닝
- 실패 패턴 분석
- `manual-trigger` 엔드포인트
- 성능 최적화 (불필요 API 호출 제거)
- 문서 업데이트

---

## 13. 결정 기록 (Decisions Log)

| # | 결정 | 근거 |
|---|------|------|
| 1 | B+C 방식 (2단계 파이프라인 + bounded/full agent 혼합) | 품질·비용·복잡도 균형 |
| 2 | Cron 09:00 JST (00:00 UTC) | 사용자 아침 검토 직전 완료 |
| 3 | 초기 탐색 비율 7:8 (= 47%), 동적 학습 | 신규 발굴 적극성 ↔ 안전성 균형 |
| 4 | 경쟁사 방송은 태그로만 (제외 아님) | 검증된 수요 신호로 활용 |
| 5 | 자사 소싱 이력 = `product_summaries` | 기존 테이블 활용 |
| 6 | 과거 추천 제외 기간 = 7일 | 후보 재노출 최소 주기 |
| 7 | B 기본 + C on-demand | 30개 매일 C 생성은 비용 과다 |
| 8 | 제조사 추적은 A+B (Rakuten + 제조사 판정), C (B2B) 제외 | 초기 범위 제어 |
| 9 | 피드백 = 4버튼 + deep-dive 암묵 | 태깅 부담 최소, 신호 충분 |
| 10 | 거절 이유 5종 고정 | 학습 분류 단순화 |
| 11 | 일일 + 주간 2단계 학습 | 반응성 ↔ 패턴 분석 균형 |
| 12 | 수동 override 없음 | 자동 학습 신뢰 |
| 13 | 비동기 enrichment (waitUntil + 폴링) | Vercel Queues beta 리스크 회피 |
| 14 | 내부 도구, 로그인/RLS 없음 | 사용자 명시 |
| 15 | 30개 단일 스크롤 (페이지네이션 없음) | 전체 개관 용이 |
| 16 | PC 우선, 모바일 stretch goal | 실제 사용 환경 |
| 17 | `rakuten_item_code` 교차-세션 dedup | 중복 방지 강화 |
| 18 | `/api/recommend` 및 `daily-refresh` 유지 | 점진 마이그레이션 |

---

## 14. 파일 영향 요약

**신규**:
```
app/api/cron/daily-discovery/route.ts
app/api/cron/daily-learning/route.ts
app/api/cron/weekly-insights/route.ts
app/api/discovery/today/route.ts
app/api/discovery/sessions/route.ts
app/api/discovery/sessions/[id]/route.ts
app/api/discovery/enrich/[productId]/route.ts (POST+GET)
app/api/discovery/enrich/[productId]/worker/route.ts
app/api/discovery/feedback/route.ts
app/api/discovery/insights/route.ts
app/api/discovery/manual-trigger/route.ts

app/[locale]/discovery/page.tsx
app/[locale]/discovery/[sessionId]/page.tsx
app/[locale]/discovery/insights/page.tsx

lib/discovery/types.ts
lib/discovery/pipeline.ts
lib/discovery/plan.ts
lib/discovery/pool.ts
lib/discovery/exclusion.ts
lib/discovery/curate.ts
lib/discovery/orchestrator.ts
lib/discovery/broadcast.ts
lib/discovery/save.ts
lib/discovery/enrich-agent.ts
lib/discovery/wholesale-rules.ts
lib/discovery/tools/rakuten-page.ts
lib/discovery/tools/extract-manufacturer.ts
lib/discovery/tools/fetch-meta.ts
lib/discovery/tools/estimate-wholesale.ts
lib/discovery/tools/tv-script.ts
lib/discovery/learning.ts

components/discovery/*.tsx (9개 + charts 3개)

supabase/migrations/2026-04-18_discovery_system.sql
scripts/test-discovery-dry-run.ts
scripts/test-enrich-dry-run.ts

messages/ja.json, messages/en.json (discovery.* 키 추가)
```

**수정**:
```
vercel.json (crons + functions)
app/[locale]/page.tsx (진입 배너)
package.json (recharts 추가)
.env.example (신규 env 4개 추가)
```

**Deprecated (점진 제거)**:
```
lib/md-strategy.ts::discoverNewProducts()  -- 호출처 정리 후 삭제
```

---

## 15. 오픈 이슈

없음. 모든 결정 항목 해소.
