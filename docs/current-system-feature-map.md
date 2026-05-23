# Current System Feature Map

작성 기준일: 2026-05-23

이 문서는 현재 코드 기준으로 홈쇼핑 신상품 추천 시스템의 기능, 데이터 흐름, 통합 지점, 확인된 공백을 정리한다. 목표는 "기존 내부 홈쇼핑 상품/매출 데이터"와 "현재 경쟁 홈쇼핑/방송 데이터"를 함께 사용해 신상품을 추천하고, 그 상품을 어떻게 팔아야 하는지 설명하는 전체 시스템을 명확히 이해하는 것이다.

## 1. 전체 목적

현재 시스템은 하나의 단일 파이프라인이 아니라 여러 기능이 연결된 구조다.

1. 내부 상품/매출 데이터를 적재하고 분석한다.
2. 경쟁 홈쇼핑/TV/라이브 커머스 데이터를 매일 수집한다.
3. 경쟁 데이터, 내부 판매 학습값, 외부 검색/Rakuten 데이터를 조합해 신상품 후보를 발굴한다.
4. 후보 상품을 심화 조사해 제조/도매/방송 적합성/C 패키지 정보를 만든다.
5. MD 전략 및 라이브 커머스 전략 워크플로우가 내부 실적과 발굴 풀을 사용해 "무엇을 팔지"와 "어떻게 팔지"를 제안한다.
6. 상품 리서치 결과와 방송/경쟁 데이터를 사용해 수출/일본 판매 리포트를 만든다.
7. 방송 대본 생성 기능은 리서치 상품 상세 페이지와 연결되어, 상품 리포트에서 바로 product-linked screenplay를 만들 수 있다.

## 2. 기능 요약표

| 영역 | 현재 역할 | 주요 UI | 주요 API/cron | 주요 데이터 |
| --- | --- | --- | --- | --- |
| 인증/권한/내비게이션 | 사용자 역할별 접근 제어와 영역별 메뉴 구성 | `app/[locale]/*/layout.tsx` | `proxy.ts`, `lib/auth/require-user.ts` | Supabase auth, `profiles` |
| 내부 상품/매출 분석 | 상품 대장 업로드, 상품별/연도별/카테고리별 실적 조회 | `app/[locale]/(firm)/analytics/*` | `/api/products/upload-taicho`, `/api/analytics/overview`, `/api/analytics/products` | `product_details`, `product_images`, `product_summaries`, `annual_summaries`, `category_summaries`, `sales_weekly` |
| 상품 리서치 | 업로드 상품을 Gemini/검색으로 분석하고 리포트 저장 | `app/[locale]/(document)/products/*` | `/api/upload`, `/api/analyze`, `/api/analyze/synthesize` | `products`, `product_files`, `research_results` |
| 경쟁 방송 캘린더 | QVC/Shop Channel 및 기타 OA 채널 방송 데이터 수집/조회 | `app/[locale]/(market)/broadcasts/page.tsx` | `/api/broadcasts`, `/api/historical-broadcasts`, `/api/cron/daily-broadcasts`, `/api/cron/daily-historical-broadcasts` | `broadcasts`, `broadcast_products`, `historical_broadcasts`, `historical_crawl_runs` |
| 신상품 발굴 | 홈쇼핑/라이브 커머스별 daily discovery 실행 및 후보 저장 | `app/[locale]/(market)/analytics/discovery/*` | `/api/cron/daily-discovery-home`, `/api/cron/daily-discovery-live`, `/api/discovery/today`, `/api/discovery/history` | `discovery_runs`, `discovered_products`, `learning_state`, `product_feedback` |
| C 패키지 심화 조사 | 발굴 상품의 제조/도매/방송 스크립트/SNS 트렌드 조사 | `components/discovery/ProductCard.tsx` | `/api/discovery/enrich/[productId]`, `/api/discovery/enrich/[productId]/worker` | `discovered_products.c_package`, enrichment status fields |
| 발굴 상품 리서치 승격 | C 패키지 완료 후보를 리서치 상품으로 전환 | `components/discovery/IntegrationActions.tsx` | `/api/discovery/[productId]/promote-to-research` | `products.discovered_product_id`, `research_results`, `product_feedback` |
| MD 전략 | 내부 실적과 발굴/리서치 풀을 사용해 상품군/채널/가격/마케팅/재무/리스크 전략 생성 | `components/analytics/MDStrategyPanel.tsx` | `/api/analytics/md-strategy` | `md_strategies`, `discovered_products`, `research_results`, analytics summaries |
| 라이브 커머스 전략 | 플랫폼/콘텐츠/실행/리스크 중심의 라이브 판매 전략 생성 | `components/analytics/LiveCommercePanel.tsx` | `/api/analytics/live-commerce` | live workflow outputs, search results, analytics context |
| 방송 대본 | 상품 브리프를 기반으로 방송 대본 생성/수정 | `app/[locale]/(produce)/screenplays/*` | `/api/screenplays` | `screenplays` |
| 관리자/운영 | 사용자, 크롤링 상태, 스킬 레지스트리, 아카이브 상태 관리 | `app/[locale]/(admin)/admin/*` | admin APIs, cron routes | skill registry, crawl run tables, archive status |

## 3. 주요 데이터 흐름

### 3.1 내부 상품/매출 데이터 흐름

1. 상품 대장 파일을 `/api/products/upload-taicho`로 업로드한다.
2. `lib/taicho-parser.ts`가 Excel 대장에서 상품 개요, 공급사, 카테고리, SKU, 원가/도매가, 제조국, 배송, 웹 정보, 담당자, 이미지를 추출한다.
3. 구조화된 정보는 `product_details`에 저장되고, 이미지 파일은 S3에 저장된 뒤 `product_images`에 연결된다.
4. 매출 분석 API는 `product_summaries`, `annual_summaries`, `category_summaries`, `sales_weekly`를 읽어 개요/상품별/주차별 실적을 제공한다.
5. MD 전략 워크플로우는 이 데이터를 판매 성과와 카테고리 학습의 기준으로 사용한다.

현재 의미:

- 내부 데이터는 "이미 잘 팔린 카테고리/가격대/마진/주차 추이"를 판단하는 기반이다.
- 발굴 자체는 주로 `learning_state`, discovery pool, broadcast context를 사용하지만, 전략 단계에서는 내부 실적 요약이 강하게 사용된다.

### 3.2 경쟁 홈쇼핑/방송 데이터 흐름

1. `/api/cron/daily-broadcasts`가 QVC/Shop Channel 방송 편성 및 상품 스냅샷을 수집한다.
2. `/api/cron/daily-historical-broadcasts`가 Japanet, Junsanpo, NTV, TBS, Dinos, Senobura, Uranoura, TV Tokyo 계열, Ropping, KAN TV 등 기타 OA 채널 데이터를 수집한다.
3. 현재/과거 방송 데이터는 `broadcasts`, `broadcast_products`, `historical_broadcasts`에 저장된다.
4. `/api/broadcasts`와 `/api/historical-broadcasts`가 캘린더와 검색 UI에 데이터를 제공한다.
5. Discovery는 최근 방송 및 TV 채널 검색 결과를 후보 상품 점수에 반영한다.
6. 상품 리서치 합성 단계는 `lib/research/competitor-context.ts`를 통해 카테고리 기반 방송/경쟁 데이터를 리포트 프롬프트에 추가한다.

현재 의미:

- 경쟁 방송 데이터는 단순 조회용이 아니라 discovery 점수, research report, strategy prompt의 근거 데이터로 쓰인다.
- 단, 리서치 경쟁 데이터 조회는 현재 카테고리 exact match 중심이라 카테고리 명칭이 다르면 근거가 비는 위험이 있다.

### 3.3 신상품 발굴 흐름

1. `/api/cron/daily-discovery-home`와 `/api/cron/daily-discovery-live`가 각각 `home_shopping`, `live_commerce` 컨텍스트로 실행된다.
2. `lib/discovery/orchestrator.ts`가 학습 상태, 인기 카테고리, 최근 키워드, Rakuten hot set을 기반으로 카테고리 계획을 만든다.
3. `lib/discovery/pool.ts`가 Rakuten, Brave 검색, TV 채널 site search, 최근 방송 데이터를 모아 후보 pool을 만든다.
4. 후보는 중복 제거, 제외 규칙, 큐레이션, TV 채널 우선 tier, Rakuten hot boost, 방송 증거 boost, 최근 QVC penalty, competitor trend boost 등을 거친다.
5. `lib/discovery/save.ts`가 `discovery_runs`와 `discovered_products`에 결과를 저장한다.
6. Discovery UI는 `/api/discovery/today`, `/api/discovery/history`, `/api/discovery/sessions/[id]`를 통해 최신/과거 세션을 표시한다.
7. 사용자는 feedback, enrichment, strategy seed, research promotion을 실행할 수 있다.

현재 의미:

- 신상품 추천의 1차 후보 생성기는 discovery pipeline이다.
- `home_shopping`과 `live_commerce`가 분리되어 있으며, 동일한 구조를 다른 컨텍스트로 실행한다.
- TV 채널 source/tier 정보가 후보 생존과 정렬에 큰 영향을 준다.

### 3.4 C 패키지 및 리서치 승격 흐름

1. Discovery 상품 카드에서 enrichment를 실행한다.
2. `/api/discovery/enrich/[productId]`가 큐 상태로 바꾸고 worker를 호출한다.
3. `/api/discovery/enrich/[productId]/worker`가 `lib/discovery/enrich-agent.ts`를 실행한다.
4. Gemini tool-calling agent가 Brave, Rakuten page, URL metadata, wholesale rules, TV script tool을 사용해 C 패키지를 만든다.
5. C 패키지 완료 상품은 `/api/discovery/[productId]/promote-to-research`로 리서치 상품으로 승격할 수 있다.
6. 승격된 상품은 `products.discovered_product_id`로 원본 discovery 상품과 연결되고, 리서치 합성 단계가 내부 secret으로 실행된다.

현재 의미:

- Discovery 후보는 바로 최종 상품이 아니라, C 패키지와 리서치 승격을 거치며 판매 가능성이 더 구체화된다.
- 이 연결은 이미 구현되어 있어 "발굴 후보 -> 리서치 리포트" 경로는 존재한다.

### 3.5 MD 전략 흐름

1. `/api/analytics/md-strategy` POST가 strategy workflow를 시작한다.
2. `lib/workflows/md-strategy.workflow.ts`가 내부 실적 context와 seed context를 읽는다.
3. 7개 MD 스킬이 순차 실행된다.
   - goal analysis
   - product selection
   - channel strategy
   - pricing/margin
   - marketing execution
   - financial projection
   - risk/contingency
4. 마지막 discovery step은 `lib/md-strategy.ts`의 `discoverNewProducts`를 사용한다.
5. `discoverNewProducts`는 discovery pool을 먼저 보고, research pool을 일부 보강한 뒤, 부족하면 fresh search로 채운다.
6. 결과는 `md_strategies`에 저장되고 UI는 판매 전략 및 추천 상품을 표시한다.

현재 의미:

- "어떤 신상품을 추천하고 어떻게 팔 것인가"에 가장 가까운 구현은 MD 전략 기능이다.
- 이미 discovery pool, research pool, fresh search를 묶어 쓰는 구조가 있다.
- `pool_source`가 `discovery`, `research`, `fresh`, `seed` 등으로 보존되어 출처 표시도 가능하다.

### 3.6 라이브 커머스 전략 흐름

1. `/api/analytics/live-commerce`가 live commerce workflow를 시작한다.
2. `lib/workflows/live-commerce.workflow.ts`가 6개 스킬을 실행한다.
   - goal analysis
   - market research
   - platform analysis
   - content strategy
   - execution plan
   - risk analysis
3. `lib/live-commerce-strategy.ts`가 플랫폼 reference, 내부 context, Brave 검색 결과를 조합한다.
4. 최종적으로 라이브 커머스에 맞는 상품/콘텐츠/운영 전략을 만든다.

현재 의미:

- 홈쇼핑 MD 전략과 병렬로 라이브 커머스용 전략 축이 있다.
- discovery도 `live_commerce` 컨텍스트로 별도 실행되므로 상품 후보 원천이 분리된다.

### 3.7 방송 대본 흐름

1. `/api/screenplays` POST가 `productBrief` 또는 `productId`를 받아 screenplay workflow를 시작한다.
2. `lib/workflows/screenplay.workflow.ts`가 대본 생성/수정 workflow를 실행한다.
3. `productId` 입력일 때는 `products`, `research_results`, 연결된 `discovered_products.c_package`를 읽어 상품 브리프를 자동 구성한다.
4. 결과는 `screenplays`에 저장되고 `app/[locale]/(produce)/screenplays/*`에서 조회/수정한다.

현재 의미:

- 판매 방법을 실행물로 바꾸는 대본 기능은 있다.
- 리서치 상품 상세 페이지에는 "台本を作成" 버튼이 있고, 생성된 screenplay는 `screenplays.product_id`로 원본 product와 연결된다.

## 4. 현재 기능별 상세 지도

### 4.1 인증, 권한, 내비게이션

주요 파일:

- `proxy.ts`
- `lib/auth/require-user.ts`
- `lib/nav/groups.ts`
- `app/[locale]/(firm)/layout.tsx`
- `app/[locale]/(market)/layout.tsx`
- `app/[locale]/(produce)/layout.tsx`

역할:

- locale은 `ja`, `ko`를 지원하고 기본값은 `ja`다.
- `admin`, `member`, `viewer` 역할이 있다.
- viewer는 제한적으로 firm analytics 일부만 볼 수 있다.
- 일반 사용자 API는 `requireUser`를 통과해야 한다.
- cron/workflow/internal API는 `CRON_SECRET` 기반 bearer secret을 사용한다.

통합상 의미:

- discovery/strategy/research/screenplay는 member/admin 중심 기능이다.
- 내부 worker 호출은 사용자 쿠키가 아니라 internal secret 경로로 정리해야 한다.

### 4.2 내부 상품/매출 분석

주요 파일:

- `app/api/products/upload-taicho/route.ts`
- `lib/taicho-parser.ts`
- `app/api/analytics/overview/route.ts`
- `app/api/analytics/products/route.ts`

주요 테이블:

- `product_details`
- `product_images`
- `product_summaries`
- `annual_summaries`
- `category_summaries`
- `sales_weekly`

출력:

- 연도별 매출/이익/수량/마진
- 카테고리 breakdown
- 상품별 실적과 주차별 추이
- viewer용 민감 지표 masking

소비자:

- analytics UI
- MD strategy context
- 향후 discovery learning/category normalization의 기준 데이터

### 4.3 상품 리서치

주요 파일:

- `components/FileUpload.tsx`
- `app/api/upload/route.ts`
- `app/api/analyze/route.ts`
- `app/api/analyze/synthesize/route.ts`
- `lib/gemini.ts`
- `lib/research/competitor-context.ts`
- `app/[locale]/(document)/products/[id]/page.tsx`

주요 테이블:

- `products`
- `product_files`
- `research_results`

흐름:

- 파일 업로드
- Gemini Vision 기반 정보 추출
- Brave/Rakuten/Gemini 검색 기반 리서치
- 경쟁 방송 context 병합
- `research_results` 저장
- 상품 리포트 페이지 렌더링

현재 통합 상태:

- `/api/upload`는 `/api/analyze`를 fire-and-forget으로 호출할 때 `CRON_SECRET` 기반 internal `Authorization`을 포함한다.
- `/api/analyze`는 일반 사용자 인증과 internal secret 호출을 모두 허용한다.
- 업로드 후 자동 분석 인증 회귀는 `scripts/test-analyze-internal-auth.ts`로 확인한다.

### 4.4 경쟁 방송 캘린더와 OA 크롤링

주요 파일:

- `app/[locale]/(market)/broadcasts/page.tsx`
- `app/api/broadcasts/route.ts`
- `app/api/historical-broadcasts/route.ts`
- `app/api/cron/daily-broadcasts/route.ts`
- `app/api/cron/daily-historical-broadcasts/route.ts`
- `lib/historical-crawl/index.ts`
- `lib/historical-crawl/persist.ts`
- `lib/historical-crawl/runs.ts`

주요 테이블:

- `broadcasts`
- `broadcast_products`
- `historical_broadcasts`
- `historical_crawl_runs`

출력:

- QVC/Shop Channel 편성 및 상품
- 기타 OA 채널 과거/최근 상품 노출
- 캘린더 counts
- 검색 overlay
- admin crawl 상태

소비자:

- broadcast calendar UI
- discovery TV evidence/scoring
- research competitor context
- competitor fit analysis

### 4.5 Discovery

주요 파일:

- `app/api/cron/daily-discovery-home/route.ts`
- `app/api/cron/daily-discovery-live/route.ts`
- `lib/discovery/orchestrator.ts`
- `lib/discovery/pool.ts`
- `lib/discovery/save.ts`
- `lib/discovery/tv-channels.ts`
- `app/[locale]/(market)/analytics/discovery/home/page.tsx`
- `app/[locale]/(market)/analytics/discovery/live/page.tsx`
- `app/[locale]/(market)/analytics/discovery/history/page.tsx`
- `app/[locale]/(market)/analytics/discovery/session/[sessionId]/page.tsx`
- `components/discovery/ProductCard.tsx`

주요 테이블:

- `discovery_runs`
- `discovered_products`
- `learning_state`
- `product_feedback`

출력:

- 일별 home shopping 후보
- 일별 live commerce 후보
- source badge, TV channel tier, score breakdown
- category frequency
- feedback 및 enrichment action

소비자:

- Discovery UI
- Strategy discovery pool
- Research promotion
- Learning feedback

### 4.6 Discovery enrichment / C package

주요 파일:

- `components/discovery/ProductCard.tsx`
- `components/discovery/IntegrationActions.tsx`
- `app/api/discovery/enrich/[productId]/route.ts`
- `app/api/discovery/enrich/[productId]/worker/route.ts`
- `lib/discovery/enrich-agent.ts`

출력:

- 제조사/공급 가능성
- 도매가 추정
- MOQ/리드타임 단서
- TV script angle
- SNS trend
- C package JSON

소비자:

- discovery card drawer
- strategy seed context
- research promotion

### 4.7 Discovery -> Research promotion

주요 파일:

- `components/discovery/IntegrationActions.tsx`
- `app/api/discovery/[productId]/promote-to-research/route.ts`
- `lib/discovery/promote-to-research.ts`
- `scripts/promote-discovered-to-research.ts`
- `supabase/migrations/2026-05-20_research_discovery_link.sql`

주요 테이블:

- `products.discovered_product_id`
- `products.ingest_source`
- `research_results`
- `product_feedback`

현재 상태:

- 구현되어 있다.
- C package 완료가 필요하다.
- 같은 discovery 상품의 중복 승격을 막는 idempotent 경로가 있다.
- 승격 후 리서치 합성은 internal secret으로 트리거된다.
- 운영자는 `npm run promote:discovery-research`로 C 패키지 완료 후보를 dry-run 확인할 수 있고, `-- --id=<discovered_product_id> --apply`를 명시해야 실제 승격한다.
- 운영자는 `npm run complete:recommendation-flow`로 Discovery 후보 승격, Research synthesis, product-linked screenplay 생성까지의 전체 실행 계획을 dry-run으로 볼 수 있다. 실제 실행은 단계별 flag(`--apply`, `--run-synthesis`, `--create-screenplay`, `--wait`)를 명시해야 한다.
- `npm run smoke:recommendation-flow`는 현재 연결 상태를 진단한다. `npm run smoke:recommendation-flow:strict`는 최신 home/live Discovery run 완료, Discovery 후보 승격, 승격 상품 Research 결과, 내부 실적+Discovery pool 외부 후보를 함께 포함한 MD Strategy, 승격 상품 연결 ready screenplay까지 없으면 실패한다.

### 4.8 MD Strategy

주요 파일:

- `app/api/analytics/md-strategy/route.ts`
- `components/analytics/MDStrategyPanel.tsx`
- `components/analytics/DiscoveredProductsHero.tsx`
- `lib/workflows/md-strategy.workflow.ts`
- `lib/md-strategy.ts`
- `lib/strategy/pool-query.ts`
- `lib/strategy/research-seed.ts`
- `lib/strategy/seed-context.ts`
- `lib/strategy/source-attribution.ts`

주요 테이블:

- `md_strategies`
- `discovered_products`
- `products`
- `research_results`
- analytics summary tables

출력:

- 목표 분석
- 상품 선택
- 채널 전략
- 가격/마진 전략
- 마케팅 실행
- 재무 예측
- 리스크 대응
- 추천 신상품 목록과 출처
- 상품별 판매 전략 분석

현재 상태:

- 신상품 추천과 판매 방법 제안의 중심 기능이다.
- discovery pool 우선, research pool 보강, fresh search fill 구조가 구현되어 있다.
- seed 상품 단일/복수 선택이 가능하다.
- 전략 상세 화면 상단에서 내부 실적, 외부 후보, 출처별 후보 수, TV/OA 신호 수, Discovery 연결 수를 함께 표시한다.

### 4.9 Live Commerce Strategy

주요 파일:

- `app/api/analytics/live-commerce/route.ts`
- `components/analytics/LiveCommercePanel.tsx`
- `lib/workflows/live-commerce.workflow.ts`
- `lib/live-commerce-strategy.ts`

출력:

- 목표 분석
- 시장 조사
- 플랫폼 분석
- 콘텐츠 전략
- 실행 계획
- 리스크 분석
- 라이브 커머스용 추천/운영 전략

현재 상태:

- 홈쇼핑 MD 전략과 별도로 라이브 커머스 목적의 전략 생성이 가능하다.
- discovery도 live commerce 컨텍스트로 별도 실행된다.

### 4.10 Screenplay

주요 파일:

- `app/api/screenplays/route.ts`
- `lib/workflows/screenplay.workflow.ts`
- `app/[locale]/(produce)/screenplays/*`

주요 테이블:

- `screenplays`

현재 상태:

- 상품 브리프 기반 대본 생성 기능은 있다.
- 리서치 상품 상세 페이지에서 직접 대본 생성을 시작할 수 있다.
- `/api/screenplays`는 기존 `productBrief` 입력과 새 `productId` 입력을 모두 지원한다.
- `productId` 기반 생성은 `screenplays.product_id`를 저장해 Research 상품과 대본을 연결한다.

## 5. "신상품 추천 + 판매 방법" 관점의 현재 조합

현재 시스템에서 목표를 달성하는 주 경로는 다음과 같다.

1. 내부 실적 데이터가 어떤 카테고리/가격/마진/채널이 좋은지 알려준다.
2. 방송/경쟁 데이터가 현재 시장에서 어떤 상품이 노출되고 있는지 알려준다.
3. Discovery가 내부 학습값, Rakuten, Brave, TV channel source, 방송 evidence를 조합해 신상품 후보를 만든다.
4. Enrichment가 후보별 공급/도매/방송 포인트를 구체화한다.
5. Research promotion이 후보를 정식 리서치 상품으로 올리고 경쟁 방송 context가 포함된 리포트를 만든다.
6. MD strategy가 내부 실적, discovery pool, research pool, fresh search를 합쳐 추천 상품과 판매 전략을 생성한다.
7. Screenplay는 Research 상품 상세 페이지와 운영 CLI에서 생성할 수 있어, 추천/리서치 결과를 방송 대본 실행물로 연결한다.

즉, "추천"은 Discovery + MD Strategy에 이미 분산 구현되어 있고, "어떻게 팔지"는 MD Strategy + Live Commerce Strategy + Screenplay에 분산 구현되어 있다. 현재는 운영 CLI와 smoke gate로 이 경로를 한 흐름으로 확인할 수 있으며, strict gate는 실제 운영 DB에서 후보 승격, 리서치 결과, 내부 실적+Discovery pool 외부 후보가 함께 들어간 MD Strategy, ready screenplay까지 확인한다.

## 6. 확인된 통합 공백과 우선순위

### P0. 업로드 상품 자동 분석 인증 경로 수정 완료

증상:

- `/api/upload`가 `/api/analyze`를 호출하지만 인증 정보를 넘기지 않는다.
- `/api/analyze`는 `requireUser(["member", "admin"])`를 요구한다.
- 따라서 일반 업로드 후 분석이 자동으로 시작되지 않을 가능성이 높다.

구현 상태:

- `/api/analyze`는 사용자 인증 또는 internal secret을 모두 허용한다.
- `/api/upload`의 fire-and-forget 호출은 `CRON_SECRET`이 있을 때 `Authorization: Bearer ${CRON_SECRET}`를 명시한다.
- internal 호출일 때도 product ownership/status validation은 유지한다.

### P1. Research -> Screenplay 직접 연결 완료

증상:

- 리서치 상품 상세 페이지에서 대본 생성 버튼이 없다.
- `/api/screenplays`는 `productId`를 받지 않고 `productBrief`만 받는다.
- 생성된 screenplay가 원본 product와 연결되지 않는다.

구현 상태:

- `/api/screenplays`에 `productId` 입력이 추가되어 있다.
- `products`, `research_results`, 필요 시 `discovered_products.c_package`를 읽어 product brief를 자동 구성한다.
- 상품 상세 페이지에 "台本を作成" action이 추가되어 있다.

### P2. 카테고리 어휘 정규화 1차 보강 완료

증상:

- 리서치 경쟁 context는 category exact match 의존도가 높다.
- discovery, broadcast, research, internal product categories의 어휘가 다르면 같은 상품군도 연결되지 않을 수 있다.

구현 상태:

- Research broadcast context 조회는 raw category exact match에 더해 normalized whitelist category 후보를 함께 조회한다.
- 현재 연결 DB에는 `discovered_category_normalization` 테이블이 적용되어 있고, `discovered_products`의 distinct raw category 428개가 whitelist category로 백필되어 있다.
- MD Strategy의 discovery/research pool 필터와 내부 실적 우선순위 정렬은 `lib/strategy/category-mapping.ts`의 공통 alias를 사용한다. `コスメ`, `ビューティ`, `家電`, `グルメ・お酒`, `ホーム・キッチン` 같은 경쟁/정규화 카테고리가 `化粧品`, `美容・運動`, `家電・雑貨`, `食品`, `キッチン` 같은 내부 sales 카테고리와 함께 매칭된다.
- `npm run test:category-normalize`는 단순 반환값뿐 아니라 `normalizeCategory`/`normalizeCategoriesBatch`가 캐시 행을 실제로 저장하고 다시 읽을 수 있는지 검증한다.
- 남은 보강은 DB 차원의 normalized category 컬럼/alias를 방송/상품 테이블 전체에 일관 적용하는 것이다.

### P3. 추천에서 판매 실행물까지의 end-to-end smoke 1차 완료

아래 경로를 확인하는 smoke와 운영 CLI가 추가되었다.

1. discovery session 상품 선택
2. enrichment 완료
3. research promotion
4. research result 생성
5. strategy seed로 사용
6. screenplay 생성

`npm run smoke:recommendation-flow`는 진단용으로 현재 상태와 부족한 단계를 보여준다. `npm run smoke:recommendation-flow:strict`는 최신 home/live Discovery run, 실제 승격 상품, 승격 상품의 research result, 내부 실적과 Discovery pool 외부 후보를 함께 포함한 MD Strategy, 승격 상품 연결 ready screenplay가 없으면 실패한다. `scripts/complete-recommendation-flow.ts`는 dry-run 계획을 보여주고, `--apply`, `--run-synthesis`, `--create-screenplay`, `--wait` flag로 단계별 실행을 명시하게 한다. 같은 판정 로직은 `lib/recommendation/flow-evidence.ts`에 재사용 가능하게 분리되어 있고, `/api/recommendation-flow/status`와 `/analytics/strategy/status` 화면에서 현재 strict readiness와 check 목록을 조회할 수 있다.

### P4. 사용자/운영자용 문서 1차 보강 완료

기존 `README.md`는 기본 Next.js 템플릿에 가까웠고, 실제 시스템 구조는 `CLAUDE.md`와 계획 문서에 흩어져 있었다.

구현 상태:

- `README.md`를 시스템 개요, 핵심 데이터 흐름, 주요 UI, env 그룹, 운영 명령, verification gate, cron schedule, 장애 확인 절차 중심으로 교체했다.
- `.env.example`에 필요한 env 변수 이름과 기본값을 정리했다. 실제 secret 값은 포함하지 않는다.
- `docs/user-guide-jp.md`의 발굴 시간과 cron schedule을 현재 `vercel.json` 기준으로 갱신했다.
- `/api/recommendation-flow/status`와 `/analytics/strategy/status`를 통해 운영 UI/자동화가 CLI와 같은 기준으로 전체 추천 플로우 readiness를 읽을 수 있다.
- 추천 플로우 status는 상품 흐름뿐 아니라 category normalization cache, 방송 카테고리 coverage, 운영자 fit 분석 카테고리 coverage도 함께 보여준다. strict gate는 상품 실행 흐름을 막는 항목을 fail 처리하고, 근거 데이터 coverage 부족은 운영 경고로 노출한다.
- Category normalization status는 `discovered_category_normalization` 전체를 훑지 않고, 현재 `discovered_products.category` distinct 값만 chunked `.in(...)`으로 조회한다. OA 상품명 분류 캐시가 같은 테이블에 대량으로 섞여도 Discovery raw category coverage가 조회 제한/정렬에 흔들리지 않는다.
- OA 방송 카테고리는 `npx tsx --env-file=.env.local scripts/backfill-historical-broadcast-categories.ts --row-limit=200 --max-products=20 --apply`처럼 제한된 배치로 채울 수 있다. 백필 dry-run의 `plannedRows`는 샘플 행 수가 아니라 같은 상품명으로 남아 있는 실제 null category 행 수를 기준으로 계산한다. 2026-05-23 현재 `historical_broadcasts.category`는 OA 10671/49320건까지 채워져 있고, 전체 방송 카테고리 coverage는 QVC/ShopCh 1402/1668 포함 23.7%로 status gate를 통과한다.
- 운영자 fit 분석 카테고리는 `npx tsx --env-file=.env.local scripts/backfill-operator-fit-categories.ts --limit=100 --apply`로 같은 방송 슬롯의 `broadcasts.category`에서 역보강할 수 있다. 2026-05-23 현재 기존 2건 모두 `家電`으로 채워져 operator fit category coverage는 2/2(100%)다. `/api/broadcasts/analyze-fit`도 새 분석 저장 시 category가 없으면 같은 역조회로 보강한다.

## 7. 관련 검증 명령

현재 코드 변경을 검증할 때 우선순위가 높은 명령은 다음과 같다.

```bash
npm run lint
npx tsc --noEmit
npm run test:migrations
npm run test:category-normalize
npm run test:historical-category-backfill
npm run test:operator-fit-category-backfill
npm run test:research-category-candidates
npx tsx --env-file=.env.local scripts/test-gemini-json-parser.ts
npx tsx --env-file=.env.local scripts/test-research-synthesis-service.ts
npx tsx --env-file=.env.local scripts/test-discovery-session-reconcile.ts
npm run test:recommendation-flow-status
npm run test:recommendation-flow-status-view
npm run test:strategy-sub-tabs-i18n
npm run test:recommendation-strategy-evidence
npm run test:strategy-category-mapping
npm run test:recharts-responsive-container
npm run test:strategy-pool
npm run test:tv-evidence-unit
npm run test:broadcasts-parsers
npm run smoke:recommendation-flow
npm run smoke:recommendation-flow:strict
npm run promote:discovery-research
npm run complete:recommendation-flow
npx tsx --env-file=.env.local scripts/complete-recommendation-flow.ts --id=<discovered_product_id>
```

주의:

- 현재 작업 전부터 discovery cron/save 관련 수정과 `scripts/test-discovery-session-reconcile.ts`가 작업 트리에 존재한다.
- 이 문서는 해당 변경을 되돌리지 않고, 현재 코드 기준 기능 파악만 기록한다.

## 8. 다음 구현 계획 초안

1. Research synthesis의 JSON 출력 안정성을 계속 관찰하고, 실패 케이스가 쌓이면 schema validation/repair 전용 계층을 추가한다.
2. discovery, broadcast, internal product category의 normalized category 컬럼/alias를 DB 레벨에서 더 일관되게 적용한다.
3. README/user guide가 충분하지 않다고 판단되면 역할별 화면 캡처와 장애 대응 예시를 더 추가한다.

## 9. 현재 검증 상태

2026-05-23 기준으로 다음은 구현/검증되었다.

- 업로드 상품의 `/api/upload` -> `/api/analyze` 비동기 내부 인증 경로가 있다.
- Discovery C package 완료 후보를 Research 상품으로 승격하는 공통 서비스가 있다.
- `/api/analyze/synthesize`와 운영 CLI는 같은 Research synthesis 서비스를 사용한다.
- Research 상품 상세에서 product-linked screenplay 생성 버튼이 보인다.
- Research competitor context는 raw category와 normalized whitelist category를 함께 조회한다.
- `README.md`와 `.env.example`은 운영자가 전체 흐름, env, cron, smoke gate, 장애 확인 절차를 확인할 수 있게 정리되어 있다.
- `docs/user-guide-jp.md`의 daily routine/cron schedule은 현재 `vercel.json` schedule과 맞다.
- `npm run smoke:recommendation-flow`는 home/live Discovery, C package 후보, Research 승격/합성, 내부 실적+Discovery pool 외부 후보 통합 MD Strategy, product-linked screenplay 존재 여부를 진단한다.
- `npm run smoke:recommendation-flow:strict`는 최신 home/live Discovery run 모두 completed 상태인지까지 확인하는 진짜 end-to-end proof gate다.
- `/analytics/strategy/status`는 category normalization cache와 방송/운영자 fit category coverage를 함께 보여주므로, 추천 흐름이 통과해도 근거 데이터가 얇은 상태를 운영자가 바로 확인할 수 있다. 현재 상태 화면은 한국어/일본어 모두 모든 체크 통과로 표시된다.
- MD Strategy 상세 화면은 내부 실적 8건, 외부 후보 20건, 발굴/신규검색/리서치 출처별 후보 수, TV/OA 신호 수, Discovery 연결 수를 한 배너에서 보여준다.
- 현재 DB에서 Discovery -> Research promotion -> Research synthesis -> 내부 실적+Discovery pool 외부 후보 통합 MD Strategy -> product-linked ready screenplay까지 strict gate를 통과했다.
- 현재 data coverage는 Discovery raw category 428/428, normalization cache rows 1330, 방송 카테고리 coverage 23.7%(QVC/ShopCh 1402/1668, OA 10671/49320), operator fit category 2/2(100%)로 strict smoke와 status UI 기준을 통과했다.

현재 검증된 end-to-end row:

- Discovery 후보: `3a3a8438-9afd-4f1a-a5bb-d1e91d340df3`
- 승격 Research 상품: `89af86a0-ff55-48cc-9ed9-506f9d0e6b7e`
- 내부 실적+Discovery pool 외부 후보 통합 MD Strategy: `2b051561-e464-4f7f-a350-b663a16f85b3`
- 연결 screenplay: `cfc6f41f-f32f-434e-8199-957565a5a8e0` (`ready`)

운영자가 dry-run을 확인하려면 다음을 실행한다.

```bash
npx tsx --env-file=.env.local scripts/complete-recommendation-flow.ts --id=3a3a8438-9afd-4f1a-a5bb-d1e91d340df3
```

새로운 C package 완료 후보를 전체 흐름으로 실행하려면 다음처럼 직접 script에 flag를 넘긴다. PowerShell/npm 환경에서는 `npm run ... -- --id=...` 형식이 npm config로 해석될 수 있으므로, 운영 명령은 direct `tsx` 형식을 권장한다.

```bash
npx tsx --env-file=.env.local scripts/complete-recommendation-flow.ts --id=<discovered_product_id> --apply --run-synthesis --create-screenplay --wait
```

`--run-synthesis`는 dev server를 요구하지 않고 shared Research synthesis 서비스를 CLI에서 직접 실행한다. `--create-screenplay`는 CLI 환경에서 Workflow SDK를 거치지 않고 같은 screenplay generator를 동기 실행해 `screenplay_versions`와 `screenplays.current_version_id`를 직접 저장한다.
