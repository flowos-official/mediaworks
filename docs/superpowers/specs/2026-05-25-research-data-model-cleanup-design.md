# 신규 리서치 파이프라인 — 데이터 모델 정리 (Phase 1)

> **작성일**: 2026-05-25
> **브랜치**: `research/data-model-cleanup`
> **상위 로드맵**: research 파이프라인 정비 3-phase 중 Phase 1.
> - Phase 1 (이 문서): 데이터 모델·타입·lifecycle 정리 — 기반 작업.
> - Phase 2 (별도 spec): 신뢰성·운영 — analyzing stuck 감지, admin recovery, 진행 통보, `CRON_SECRET` 폴백 제거.
> - Phase 3 (별도 spec): 출력 품질 — Pro fallback, 다중 파일 분석, extract prompt 언어 명시.
> - Phase 4 (별도 spec, 옵션): 보안 — `product-files` 버킷 잠금, `/api/analyze` internal-only 강화.

## 1. 배경 / 문제

`/[locale]/(produce)/research` (제작 → 신규 리서치) 는 외부에서 제안된 상품 문서를 업로드 받아 분석하는 핵심 화면이다. 현재 동작:

1. 파일 업로드 → `POST /api/upload` → Supabase Storage + `products` row insert (`pending`)
2. 백그라운드 `POST /api/analyze` → Gemini Vision으로 메타 추출 → `products` 컬럼 채움 (`analyzing` → `extracted`)
3. 백그라운드 `POST /api/analyze/synthesize` → Brave 13쿼리 + Rakuten + 자사 broadcasts 컨텍스트 → Gemini가 15섹션 JSON 합성 → `research_results` 저장 → `products.status='completed'`

다음 한계가 SQL 분석/유지보수를 가로막는다:

- **확장 5섹션이 `raw_json` 안에만 존재**: `distribution_channels`, `pricing_strategy`, `marketing_strategy`, `korea_market_fit`, `live_commerce`는 DB 컬럼이 없어 "한국 fit_score 70 이상 상품"·"가격대별 분포"·"live_commerce 추천 플랫폼 통계" 같은 SQL/대시보드를 만들 수 없다.
- **TS 타입 ↔ DB 스키마 drift**: `lib/supabase.ts`의 `Product`·`ResearchResult` 타입이 실제 DB 컬럼 일부를 모른다 (예: `Product.category`, `Product.features`, `Product.discovered_product_id`, `Product.ingest_source`, `ResearchResult.competitor_analysis`, `ResearchResult.recommended_price_range`, `ResearchResult.broadcast_scripts`, `ResearchResult.japan_export_fit_score`). 코드는 이 컬럼들을 read/write 하면서도 타입 안전망이 없다.
- **`status` lifecycle이 직관적이지 않음**: `pending → analyzing → extracted → analyzing → completed`. `extracted` 단계가 찰나만 존재하고 `synthesizeProductResearch`가 다시 `analyzing`으로 덮어쓴다. `ProductList.tsx`의 statusFilter는 `'analyzing'` chip이 `extracted`도 포함하도록 hack 처리되어 있다.
- **`research_results` delete-then-insert 패턴**: 재합성마다 row를 통째로 갈아엎어 `id`·`created_at`이 변경된다. 외부 URL이나 캐시가 무효화되고 history도 없다.

## 2. 목표 / 비목표

### 목표
1. 확장 5섹션을 SQL로 직접 조회·필터링·정렬할 수 있게 만든다.
2. `Product`·`ResearchResult` TS 타입이 DB 스키마와 일치한다.
3. `products.status` lifecycle을 4단계로 단순화한다 (`pending → analyzing → completed | failed`).
4. `research_results` 저장을 upsert로 전환하여 `id`·`created_at`을 보존한다.
5. 기존 row의 5섹션은 마이그레이션 안에서 즉시 백필되어 코드는 항상 새 컬럼만 읽으면 된다.

### 비목표 (다음 Phase로 미룸)
- 합성 실패 재시도 / admin recovery UI (Phase 2).
- `analyzing` 상태 영구 stuck 감지 cron (Phase 2).
- `CRON_SECRET ?? ""` 폴백 제거 (Phase 2).
- Pro 모델 fallback, 다중 파일 처리, extract prompt 언어 명시 (Phase 3).
- `product-files` 버킷 public 해제, `/api/analyze` internal-only 잠금 (Phase 4).
- discovered_product_id 연계 경로의 동작 변경 — 본 spec에서는 타입에만 반영하고 동작은 그대로 유지.

## 3. 분석 사용처 (스키마 설계 근거)

운영자가 다음과 같은 분석을 SQL로 직접 돌릴 수 있어야 한다:

- **시장 적합도 상위 리스트**: `WHERE korea_market_fit->>'fit_score' >= 70 ORDER BY ... DESC LIMIT N`, `ORDER BY japan_export_fit_score DESC`.
- **가격대 / 채널별 분포**: `distribution_channels` jsonb path 쿼리, `pricing_strategy->'channel_pricing'` 집계.
- **Strategy / Discovery 점수 반영**: discovery 풀이나 MD strategy 점수 계산 시 `korea_fit_score`·`japan_export_fit_score`를 boost 입력으로 사용 (현재의 `tv_fit_score` 활용 패턴과 동일한 구조).
- **live_commerce 관련 집계**: `live_commerce->'platforms'`에 특정 플랫폼이 포함된 상품 수, 추천 제품 관점 키워드 통계 등.

## 4. 스키마 변경

### 4.1 마이그레이션 1 — `supabase/migrations/2026-05-25_research_extended_columns.sql`

```sql
-- 0. 사전 무결성 확인: product_id 중복이 있으면 이후 UNIQUE 제약이 실패하므로 먼저 확인 (수동).
--    실행 전 다음을 운영자가 검증한다:
--      SELECT product_id, COUNT(*) FROM research_results GROUP BY 1 HAVING COUNT(*) > 1;
--    중복이 있다면 spec 8.1의 수동 정리 절차를 따른다.

-- 1. 확장 5섹션을 별도 jsonb 컬럼으로 분리
ALTER TABLE research_results
  ADD COLUMN distribution_channels jsonb,
  ADD COLUMN pricing_strategy      jsonb,
  ADD COLUMN marketing_strategy    jsonb,
  ADD COLUMN korea_market_fit      jsonb,
  ADD COLUMN live_commerce         jsonb;

-- 2. scalar sub-field generated column (BTREE 인덱싱용)
--    Gemini 출력에서 빈 문자열이 들어올 가능성이 있어 NULLIF로 방어.
ALTER TABLE research_results
  ADD COLUMN korea_fit_score int
    GENERATED ALWAYS AS (NULLIF(korea_market_fit->>'fit_score', '')::int) STORED;

-- 3. 기존 row의 raw_json -> 새 컬럼으로 백필
UPDATE research_results SET
  distribution_channels = raw_json->'research'->'distribution_channels',
  pricing_strategy      = raw_json->'research'->'pricing_strategy',
  marketing_strategy    = raw_json->'research'->'marketing_strategy',
  korea_market_fit      = raw_json->'research'->'korea_market_fit',
  live_commerce         = raw_json->'research'->'live_commerce'
WHERE raw_json->'research' IS NOT NULL;

-- 4. product_id UNIQUE — 코드 가정(상품당 1 row)을 DB로 강제
ALTER TABLE research_results
  ADD CONSTRAINT research_results_product_id_unique UNIQUE (product_id);

-- 5. 인덱스
CREATE INDEX idx_research_korea_fit_score
  ON research_results (korea_fit_score DESC NULLS LAST);
CREATE INDEX idx_research_japan_export_fit_score
  ON research_results (japan_export_fit_score DESC NULLS LAST);
CREATE INDEX idx_research_distribution_channels
  ON research_results USING gin (distribution_channels jsonb_path_ops);
CREATE INDEX idx_research_pricing_strategy
  ON research_results USING gin (pricing_strategy      jsonb_path_ops);
CREATE INDEX idx_research_marketing_strategy
  ON research_results USING gin (marketing_strategy    jsonb_path_ops);
CREATE INDEX idx_research_live_commerce
  ON research_results USING gin (live_commerce         jsonb_path_ops);
```

**왜 generated column은 `korea_fit_score` 하나만?** Gemini 출력의 다른 scalar 후보(예: `pricing_strategy.bep_analysis.recommended_price`)는 `"3,980円"` 같은 문자열로 나올 가능성이 있어 안전하게 `int` 캐스팅이 안 된다. 백필 후 실제 분포를 확인하고 안정적인 후보만 다음 마이그레이션에서 추가한다. 본 spec에서는 인덱싱이 가장 명확하게 가치를 내는 `korea_fit_score`만 우선 도입한다.

**왜 백필을 마이그레이션 안에서?** 데이터양이 상품 수백~수천 단위로 예상되어 Postgres `UPDATE`로 충분히 빠르고, 마이그레이션 전후 데이터 형태가 일관되어 코드가 새 컬럼만 읽으면 된다 (lazy fallback 로직 없음).

### 4.2 마이그레이션 2 — `supabase/migrations/2026-05-25_products_lifecycle_simplify.sql`

```sql
-- 1. extracted 상태로 멈춰있는 row가 있으면 analyzing으로 정리
UPDATE products SET status = 'analyzing' WHERE status = 'extracted';

-- 2. CHECK constraint 갱신 (4단계로 좁힘)
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE products
  ADD CONSTRAINT products_status_check
  CHECK (status IN ('pending', 'analyzing', 'completed', 'failed'));
```

**순서 중요**: 이 마이그레이션은 코드가 이미 `'extracted'`로 쓰지 않도록 배포된 뒤에 적용해야 한다. 그렇지 않으면 in-flight 요청이 CHECK 제약으로 실패한다. 배포 순서는 §6 참조.

## 5. 코드 변경

### 5.1 `lib/supabase.ts` — TS 타입 동기화

```ts
export type ProductStatus = 'pending' | 'analyzing' | 'completed' | 'failed';

export type Product = {
  id: string;
  name: string;
  description: string | null;
  file_url: string;
  file_name: string;
  category: string | null;
  features: string[] | null;
  price_range: string | null;
  target_market: string | null;
  status: ProductStatus;
  discovered_product_id: string | null;
  ingest_source: 'file_upload' | 'discovery_promotion' | 'manual_url';
  created_at: string;
};

export type ResearchResult = {
  id: string;
  product_id: string;
  marketability_score: number | null;
  marketability_description: string | null;
  demographics: unknown | null;
  seasonality: unknown | null;
  cogs_estimate: unknown | null;
  influencers: unknown | null;
  content_ideas: unknown | null;
  competitor_analysis: unknown | null;
  recommended_price_range: unknown | null;
  broadcast_scripts: unknown | null;
  japan_export_fit_score: number | null;
  distribution_channels: unknown | null;
  pricing_strategy: unknown | null;
  marketing_strategy: unknown | null;
  korea_market_fit: unknown | null;
  live_commerce: unknown | null;
  korea_fit_score: number | null; // generated, read-only
  raw_json: { product_info?: unknown; search_results?: unknown } | null;
  created_at: string;
};
```

- `unknown` 으로 일단 좁혀두고, 각 섹션의 정밀 타입은 `lib/research/types.ts`(신설 또는 기존 위치)에서 정의해 import 한다. 본 spec에서는 정밀 타입까지는 도입하지 않고 컬럼 존재 자체만 보장한다 — 일관된 정밀 타입은 Phase 3(출력 품질) 작업과 묶는 게 자연스럽다.

### 5.2 `lib/research/synthesize-product.ts::buildResearchResultInsert`

```ts
function buildResearchResultInsert(
  productId: string,
  productInfo: ProductInfo,
  searchResults: Record<string, string>,
  research: ResearchOutput,
) {
  return {
    product_id: productId,
    marketability_score: research.marketability_score,
    marketability_description: research.marketability_description,
    demographics: research.demographics,
    seasonality: research.seasonality,
    cogs_estimate: research.cogs_estimate,
    influencers: research.influencers,
    content_ideas: research.content_ideas,
    competitor_analysis: research.competitor_analysis,
    recommended_price_range: research.recommended_price_range,
    broadcast_scripts: research.broadcast_scripts,
    japan_export_fit_score: research.japan_export_fit_score,
    // ↓ 신규: 확장 5섹션을 명시 컬럼으로 저장
    distribution_channels: research.distribution_channels,
    pricing_strategy: research.pricing_strategy,
    marketing_strategy: research.marketing_strategy,
    korea_market_fit: research.korea_market_fit,
    live_commerce: research.live_commerce,
    // raw_json은 디버깅용으로 product_info + search_results만 보관 (research 본체는 컬럼으로 빠짐)
    raw_json: { product_info: productInfo, search_results: searchResults },
  };
}
```

저장 호출은 delete-then-insert 대신 upsert로 변경:

```ts
const insert = buildResearchResultInsert(productId, productInfo, searchResults, research);
const { error } = await sb
  .from('research_results')
  .upsert(insert, { onConflict: 'product_id' });
if (error) throw new ProductResearchSynthesisError(500, error.message);
```

- `id`·`created_at`은 첫 합성 시 생성되어 이후 재합성에서도 보존된다.
- 마이그레이션 1의 UNIQUE 제약이 `onConflict: 'product_id'`의 전제다.

### 5.3 `app/api/analyze/route.ts`

```diff
- await sb.from('products').update({ ..., status: 'extracted' }).eq('id', productId);
+ await sb.from('products').update({ ..., status: 'analyzing' }).eq('id', productId);
```

추출 완료 후에도 `analyzing`을 유지한다. synthesize 단계가 곧 이어 호출되므로 사용자/UI 입장에서는 한 덩어리의 "분석 중". `synthesize-product.ts:138`의 "다시 `analyzing`으로" 라인은 idempotent하므로 그대로 둔다.

### 5.4 `app/[locale]/(document)/products/[id]/page.tsx`

```diff
- const research = data ? {
-   ...data,
-   ...(data.raw_json?.research ?? {}),
- } : null;
+ const research = data;
```

raw_json에서 확장 섹션을 spread하던 머지 로직 제거. 백필이 끝났으니 모든 row가 새 컬럼에 5섹션을 갖고 있다.

### 5.5 `components/ProductList.tsx`

- statusFilter chip에서 `extracted` OR 분기 제거 (현재 line 55 부근).
- chip 옵션을 `all | completed | analyzing | pending | failed` 4+1 으로 좁힘.
- polling 조건은 `pending | analyzing` 두 상태로 유지 (이미 동일하나 코드 상수에서 `extracted` 제거).

### 5.6 `components/ProductCard.tsx`

- 상태별 아이콘·색·메시지 매핑(line 21-47)에서 `extracted` 케이스 제거. 4가지 상태만 매핑.

### 5.7 보고서 섹션 컴포넌트들

- `components/report/DistributionChannelSection.tsx`, `PricingStrategySection.tsx`, `MarketingStrategySection.tsx`, `KoreaMarketSection.tsx`, `LiveCommerceSection.tsx`의 props는 그대로 둔다 (이미 객체 하나를 prop으로 받음).
- 호출 측 (`products/[id]/page.tsx`) 에서 raw_json 머지 없이 컬럼 값을 그대로 prop으로 넘김.

## 6. 마이그레이션·배포 순서

1. **Migration 1 적용** (`research_extended_columns.sql`) — 컬럼 + generated column + 인덱스 + 백필 + UNIQUE. 백워드 호환(기존 코드는 raw_json에서 계속 읽음).
2. **코드 배포** — 5섹션을 새 컬럼에 쓰고, raw_json에서는 빼고, upsert로 저장. report 페이지는 컬럼에서 직접 읽음. analyze는 `'analyzing'` 으로 유지. UI hack 제거.
3. **Migration 2 적용** (`products_lifecycle_simplify.sql`) — `extracted` row 정리 + CHECK 제약 4단계로. 코드가 이미 `'extracted'`로 쓰지 않게 배포된 뒤이므로 안전.

**Vercel preview에서 dry-run**: Migration 1만 적용한 preview에 코드를 배포해 정상 동작 확인 후 Migration 2를 production에 적용한다.

## 7. 검증

- `npx tsc --noEmit` 통과.
- `npm run lint` 통과.
- Migration 1 적용 후 `SELECT COUNT(*) FROM research_results WHERE raw_json->'research' IS NOT NULL AND distribution_channels IS NULL` = 0.
- 새 상품 업로드 → `/research` 페이지에서 카드가 `pending → analyzing → completed` 으로 진행 (`extracted` chip 안 보임).
- 기존 completed 상품의 `/products/[id]` 페이지가 정상 렌더 (raw_json 머지 없이 5섹션 모두 표시).
- 같은 상품을 재합성 시 `research_results.id` 변하지 않음 (upsert 확인).
- `EXPLAIN ANALYZE SELECT id, product_id, korea_fit_score FROM research_results WHERE korea_fit_score >= 70 ORDER BY korea_fit_score DESC LIMIT 20;` 에서 `idx_research_korea_fit_score` 사용.
- `EXPLAIN ANALYZE SELECT id FROM research_results WHERE live_commerce @> '{"platforms":["Instagram Live"]}'::jsonb;` 에서 `idx_research_live_commerce` 사용.

## 8. 리스크 / 미해결 항목

### 8.1 `research_results.product_id` 중복 가능성
현재 코드는 product 당 1 row를 가정하지만 DB로 강제하지 않았다. 마이그레이션 적용 전 다음을 수동 점검한다:

```sql
SELECT product_id, COUNT(*) FROM research_results GROUP BY 1 HAVING COUNT(*) > 1;
```

중복이 있다면 최신 row만 남긴다 (예: `DELETE FROM research_results a USING research_results b WHERE a.product_id = b.product_id AND a.created_at < b.created_at`). 운영자가 이 작업을 수행한 후에야 마이그레이션 적용한다.

### 8.2 generated column 캐스팅 실패
Gemini가 가끔 `fit_score`를 `"85점"`·`"N/A"` 같은 문자열로 반환할 가능성. `NULLIF(..., '')::int`는 비어있는 문자열만 NULL로 만들고 그 외 잘못된 문자열은 캐스팅 에러로 row 저장이 실패한다.

대응 두 갈래로 나뉜다:

1. **백필 시점**: 마이그레이션 적용 전 비숫자 row를 사전 점검한다.
   ```sql
   SELECT id, raw_json->'research'->'korea_market_fit'->>'fit_score' AS raw
   FROM research_results
   WHERE raw_json->'research'->'korea_market_fit'->>'fit_score' IS NOT NULL
     AND raw_json->'research'->'korea_market_fit'->>'fit_score' !~ '^[0-9]+$';
   ```
   비숫자 row가 있으면 백필 단계 전에 해당 row의 `korea_market_fit->>'fit_score'`를 정수로 정제(또는 NULL 처리)하는 `UPDATE`를 선행한다. 예:
   ```sql
   UPDATE research_results
   SET raw_json = jsonb_set(
     raw_json,
     '{research,korea_market_fit,fit_score}',
     'null'::jsonb,
     false
   )
   WHERE raw_json->'research'->'korea_market_fit'->>'fit_score' IS NOT NULL
     AND raw_json->'research'->'korea_market_fit'->>'fit_score' !~ '^[0-9]+$';
   ```

2. **새 합성 시점**: synthesize 측에서 `Number.parseInt`로 정제해 저장한다 (`research.korea_market_fit.fit_score`가 숫자가 아니면 NULL로 떨어뜨려 generated column 캐스팅 실패를 방지). Phase 3에서 Gemini `responseSchema`를 강제하면 근본 대응이 가능하다.

### 8.3 upsert 전환의 행동 변화
재합성 시 `id`와 `created_at`이 보존되어 "리포트 생성일" 표시가 처음 시점으로 고정된다. 사용자에게 "이번에 다시 분석한 결과"가 언제인지 보이려면 `updated_at timestamptz` 컬럼 추가가 필요하지만, 현재 UI에서 그 시각을 보여주는 자리가 없다. 본 spec에서는 추가하지 않고 후속 Phase에서 UX 요구가 있을 때 도입한다.

### 8.4 다른 코드 경로에서 `'extracted'` 사용
`lib/discovery/promote-to-research.ts`·`scripts/promote-discovered-to-research.ts` 등에서 `'extracted'`를 쓰는 곳이 있을 수 있다. 구현 단계에서 grep으로 전 경로를 훑어 `'extracted'` 리터럴을 모두 제거한다.

### 8.5 `raw_json` 호환성
백필 후에도 `raw_json.research`는 그대로 남는다 (`UPDATE` 가 raw_json을 건드리지 않음). 새 합성부터는 `raw_json`에 `research` 키가 들어가지 않으므로 row마다 형태가 다르다. report 페이지가 컬럼만 읽도록 변경되었으므로 동작은 안전하다. 디스크 공간이 신경 쓰인다면 별도 정리 마이그레이션을 후속으로:

```sql
UPDATE research_results SET raw_json = raw_json - 'research' WHERE raw_json ? 'research';
```

본 spec에서는 적용하지 않는다 (디버깅용 원본 보존).

## 9. 영향 받지 않는 영역 (의도적 비변경)

- discovery → research promote 경로 (`lib/discovery/promote-to-research.ts`): `products.discovered_product_id`·`ingest_source` 컬럼은 이미 존재하므로 타입에 반영만 하고 로직은 그대로.
- broadcasts·historical_broadcasts·competitor_fit_analyses 등 자사 DB 컨텍스트 로딩 (`lib/research/competitor-context.ts`): 변경 없음.
- Brave·Rakuten·Gemini 외부 호출 로직: 변경 없음.
- `/api/upload`의 다중 파일 저장: 변경 없음 (Phase 3에서 다룸).
