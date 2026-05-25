# 신규 리서치 데이터 모델 정리 (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `research_results`의 확장 5섹션(`distribution_channels` · `pricing_strategy` · `marketing_strategy` · `korea_market_fit` · `live_commerce`)을 `raw_json`에서 분리해 jsonb 컬럼으로 만들고, `Product`·`ResearchResult` TS 타입을 DB 스키마와 동기화하고, `products.status` lifecycle을 4단계(`pending → analyzing → completed | failed`)로 단순화하며, `research_results` 저장을 upsert로 전환한다.

**Architecture:** 백워드 호환 마이그레이션(컬럼 + generated column + GIN/BTREE 인덱스 + 기존 row 백필 + UNIQUE 추가)을 먼저 배포해 새 코드가 그 위에서 안전하게 동작하게 만든다. 코드는 (1) `synthesize-product.ts` 가 5섹션을 신 컬럼에 쓰고 upsert, (2) report 페이지가 컬럼에서 직접 읽음, (3) `'extracted'` 상태 리터럴이 코드 전체에서 제거된 뒤, 마지막에 lifecycle CHECK 제약을 4단계로 좁히는 마이그레이션을 적용한다.

**Tech Stack:** Supabase Postgres (jsonb, generated column STORED, GIN `jsonb_path_ops`, BTREE), Next.js 16 App Router, TypeScript, tsx 기반 라이브 DB smoke (`scripts/test-*.ts`).

---

## File Structure

### Create
- `supabase/migrations/2026-05-25_research_extended_columns.sql`
- `supabase/migrations/2026-05-25_products_lifecycle_simplify.sql`
- `scripts/test-research-data-model.ts`

### Modify
- `lib/supabase.ts` — `Product` · `ResearchResult` 타입 동기화 (Task 2에서 컬럼 확장, Task 8에서 `status` union 좁힘)
- `lib/research/synthesize-product.ts` — `buildResearchResultInsert` 확장 + delete-then-insert → upsert
- `app/api/analyze/route.ts` — extract 완료 시 status `'extracted'` → `'analyzing'`
- `lib/discovery/promote-to-research.ts` — promote insert 시 status `'extracted'` → `'analyzing'`
- `app/[locale]/(document)/products/[id]/page.tsx` — raw_json merge 제거 + 로컬 `ProductStatus` union 좁힘
- `app/api/products/[id]/route.ts` — raw_json merge 제거 (page.tsx 와 같은 패턴이 line 32-38 에 중복으로 존재)
- `components/ProductCard.tsx` — `statusConfig.extracted` 제거 + 이중 비교 제거
- `components/ProductList.tsx` — statusFilter chip의 `extracted` OR 분기 제거
- `scripts/test-promote-to-research.ts` — fixture status `'extracted'` → `'analyzing'`
- `scripts/test-recommendation-flow-readiness.ts` — fixture status 업데이트
- `messages/ja.json` · `messages/ko.json` — i18n `extracted` 키 제거 (UI 라벨에서 더 이상 사용 안 됨)
- `package.json` — `test:research-data-model` 스크립트 추가

---

## 사전 운영 절차 (Task 1 시작 전 운영자가 직접 실행)

dev / prod Supabase에서 **각각** 다음 SQL을 실행해 데이터 무결성을 확인한다. 결과가 비어있지 않으면 Task 1을 진행하지 말고 정리 작업을 먼저 수행한다.

```sql
-- A. research_results.product_id 중복 (Task 1의 UNIQUE 제약과 충돌)
SELECT product_id, COUNT(*)
FROM research_results
GROUP BY 1
HAVING COUNT(*) > 1;
```
- 비어있으면 통과.
- 비어있지 않으면 최신 row만 남긴다:
  ```sql
  DELETE FROM research_results a
  USING research_results b
  WHERE a.product_id = b.product_id
    AND a.created_at < b.created_at;
  ```

```sql
-- B. korea_market_fit.fit_score 비숫자 row (Task 1의 generated column 캐스팅과 충돌)
SELECT id, raw_json->'research'->'korea_market_fit'->>'fit_score' AS raw
FROM research_results
WHERE raw_json->'research'->'korea_market_fit'->>'fit_score' IS NOT NULL
  AND raw_json->'research'->'korea_market_fit'->>'fit_score' !~ '^[0-9]+$';
```
- 비어있으면 통과.
- 비어있지 않으면 비숫자 fit_score를 null로 정제:
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

---

## Task 1: Migration 1 — `research_extended_columns.sql` 작성 + dev 적용

**Files:**
- Create: `supabase/migrations/2026-05-25_research_extended_columns.sql`

- [ ] **Step 1: 마이그레이션 파일 작성**

다음 내용을 신규 파일로 작성한다.

```sql
-- 2026-05-25: research_results — 확장 5섹션을 raw_json에서 분리.
-- 사전 점검(plan §사전 운영 절차)이 통과한 뒤 적용한다.

-- 1) 확장 5섹션을 별도 jsonb 컬럼으로 분리.
ALTER TABLE research_results
  ADD COLUMN distribution_channels jsonb,
  ADD COLUMN pricing_strategy      jsonb,
  ADD COLUMN marketing_strategy    jsonb,
  ADD COLUMN korea_market_fit      jsonb,
  ADD COLUMN live_commerce         jsonb;

-- 2) scalar sub-field generated column.
--    Gemini 출력이 빈 문자열일 가능성이 있어 NULLIF로 방어.
ALTER TABLE research_results
  ADD COLUMN korea_fit_score int
    GENERATED ALWAYS AS (NULLIF(korea_market_fit->>'fit_score', '')::int) STORED;

-- 3) 기존 row의 raw_json -> 새 컬럼 백필.
UPDATE research_results SET
  distribution_channels = raw_json->'research'->'distribution_channels',
  pricing_strategy      = raw_json->'research'->'pricing_strategy',
  marketing_strategy    = raw_json->'research'->'marketing_strategy',
  korea_market_fit      = raw_json->'research'->'korea_market_fit',
  live_commerce         = raw_json->'research'->'live_commerce'
WHERE raw_json->'research' IS NOT NULL;

-- 4) product_id UNIQUE — 코드의 "상품당 1 row" 가정을 DB로 강제.
ALTER TABLE research_results
  ADD CONSTRAINT research_results_product_id_unique UNIQUE (product_id);

-- 5) 인덱스.
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

- [ ] **Step 2: dev Supabase에 적용**

운영자의 적용 방식에 따라:
- Supabase CLI: `supabase db push`
- 또는 Supabase Studio SQL editor에서 위 SQL 통째로 실행
- 또는 psql: `psql "$DEV_DATABASE_URL" -f supabase/migrations/2026-05-25_research_extended_columns.sql`

기대: 모든 명령이 에러 없이 완료.

- [ ] **Step 3: 백필 검증 SQL**

dev에서 다음을 실행해 0이 나오는지 확인.

```sql
SELECT COUNT(*) AS unbackfilled
FROM research_results
WHERE raw_json->'research' IS NOT NULL
  AND distribution_channels IS NULL;
```
기대: `unbackfilled = 0`.

```sql
SELECT COUNT(*) AS scoreful_rows,
       COUNT(korea_fit_score) AS computed_scores
FROM research_results
WHERE korea_market_fit->>'fit_score' ~ '^[0-9]+$';
```
기대: `scoreful_rows == computed_scores` (모두 generated column이 계산됨).

```sql
-- 인덱스 사용 확인
EXPLAIN ANALYZE
SELECT id, product_id, korea_fit_score
FROM research_results
WHERE korea_fit_score >= 70
ORDER BY korea_fit_score DESC
LIMIT 20;
```
기대: 실행 계획에 `Index Scan using idx_research_korea_fit_score`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-25_research_extended_columns.sql
git commit -m "feat(research): add migration 1 — extract 5 sections into columns

확장 5섹션(distribution/pricing/marketing/korea/live)을 raw_json에서
jsonb 컬럼으로 분리하고, korea_fit_score generated column,
BTREE/GIN 인덱스, product_id UNIQUE, raw_json -> 컬럼 백필을 함께 적용."
```

---

## Task 2: `lib/supabase.ts` — TS 타입 동기화 (status union은 일단 유지)

**Files:**
- Modify: `lib/supabase.ts`

이번 task에서는 누락된 컬럼만 타입에 반영한다. `status` union에서 `'extracted'`를 제거하는 작업은 Task 8에서 모든 사용처를 제거한 뒤에 처리한다.

- [ ] **Step 1: `Product` 타입 확장**

`lib/supabase.ts` 의 `Product` 타입 정의(현재 line 39-47 부근, `status` 가 5단계 union으로 정의된 곳)를 다음으로 교체한다.

```ts
export type ProductStatus =
  | 'pending'
  | 'analyzing'
  | 'extracted' // deprecated — Task 8/9 에서 제거됨. 그 전까지 컴파일 유지.
  | 'completed'
  | 'failed';

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
```

- [ ] **Step 2: `ResearchResult` 타입 확장**

같은 파일의 `ResearchResult` 타입 정의(현재 line 59-94 부근)를 다음으로 교체한다.

```ts
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
  korea_fit_score: number | null; // generated column, read-only
  raw_json: { product_info?: unknown; search_results?: unknown; research?: unknown } | null;
  created_at: string;
};
```

(`raw_json.research?` 는 백필이 끝난 뒤에도 기존 row에는 남아있을 수 있어 optional로 유지.)

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```

기대: 통과. 새로 추가한 필드는 모두 nullable 또는 union 확장이라 기존 코드와 충돌하지 않는다. (만약 에러가 나면 이 시점에 발견된 곳이 기존에 코드가 컬럼을 read/write 하면서도 타입을 의도적으로 무시하던 위치이므로 plan §Risk에 기록하고 별도 task로 처리.)

- [ ] **Step 4: Commit**

```bash
git add lib/supabase.ts
git commit -m "refactor(types): sync Product/ResearchResult with DB schema

Product에 누락된 category/features/price_range/target_market/
discovered_product_id/ingest_source 추가. ResearchResult에 누락된
competitor_analysis/recommended_price_range/broadcast_scripts/
japan_export_fit_score 및 신규 5섹션 컬럼·korea_fit_score 추가.
status union 좁힘은 'extracted' 사용처 제거 후 Task 8에서 처리."
```

---

## Task 3: 라이브 DB smoke 스크립트 작성

**Files:**
- Create: `scripts/test-research-data-model.ts`
- Modify: `package.json`

기존 `scripts/test-selections.ts` · `scripts/test-strategy-fresh-search.ts` 패턴을 따른다(tsx + `.env.local` + service role client + 마지막에 정리).

- [ ] **Step 1: smoke 스크립트 작성**

`scripts/test-research-data-model.ts` 를 신규 생성.

```ts
/**
 * 라이브 DB smoke for the Phase 1 data-model cleanup.
 * 실행: npm run test:research-data-model
 *
 * Migration 1이 적용된 dev DB 위에서 다음을 검증한다:
 *   - 신규 5 jsonb 컬럼 + korea_fit_score(generated) 가 존재한다
 *   - research_results.product_id UNIQUE 가 존재한다
 *   - 인덱스 6개가 모두 존재한다
 *   - 임시 product + research_results upsert 한 번 → upsert 두 번째 호출에서
 *     id 와 created_at 이 보존된다
 *   - korea_market_fit.fit_score 가 숫자면 korea_fit_score(generated) 가 같은 값
 *
 * 테스트가 끝나면 모든 임시 row 를 정리한다.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 .env.local 에 있어야 합니다.");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function fetchColumns(): Promise<Map<string, string>> {
  const { data, error } = await sb
    .rpc("pg_temp_unused", {})
    .select() as unknown as { data: null; error: { message: string } | null };
  // supabase-js 는 information_schema 를 일반 .from('information_schema.columns') 으로 못 읽으므로
  // SQL 함수가 없다면 raw SQL 을 호출하는 RPC 가 필요. 대안으로 .from('research_results').select() 한 row 의 키를 본다.
  void data; void error;
  const { data: row, error: rowErr } = await sb.from("research_results").select("*").limit(1).maybeSingle();
  if (rowErr) throw new Error(`research_results select 실패: ${rowErr.message}`);
  const cols = new Map<string, string>();
  if (row) for (const k of Object.keys(row)) cols.set(k, typeof (row as Record<string, unknown>)[k]);
  return cols;
}

async function main() {
  // 1) 컬럼 존재 확인
  const cols = await fetchColumns();
  for (const name of [
    "distribution_channels",
    "pricing_strategy",
    "marketing_strategy",
    "korea_market_fit",
    "live_commerce",
    "korea_fit_score",
  ]) {
    assert(cols.has(name), `research_results.${name} 컬럼이 존재해야 함 (Migration 1 미적용 의심)`);
  }
  console.log("[ok] 신규 컬럼 6개 존재");

  // 2) 임시 product 생성
  const tempName = `plan-smoke-${Date.now()}`;
  const { data: product, error: prodErr } = await sb
    .from("products")
    .insert({
      name: tempName,
      file_url: "smoke://none",
      file_name: "smoke.txt",
      status: "analyzing",
    })
    .select("id, created_at")
    .single();
  if (prodErr || !product) throw new Error(`product insert 실패: ${prodErr?.message}`);
  console.log(`[ok] 임시 product 생성: ${product.id}`);

  try {
    // 3) 첫 upsert
    const firstInsert = {
      product_id: product.id,
      marketability_score: 70,
      marketability_description: "smoke",
      korea_market_fit: { fit_score: 80, target_products: [], recommended_channels: [] },
      live_commerce: { platforms: ["Instagram Live"], talking_points: [] },
      distribution_channels: [],
      pricing_strategy: { channel_pricing: [], bep_analysis: {} },
      marketing_strategy: [],
    };
    const { data: first, error: firstErr } = await sb
      .from("research_results")
      .upsert(firstInsert, { onConflict: "product_id" })
      .select("id, created_at, korea_fit_score")
      .single();
    if (firstErr || !first) throw new Error(`첫 upsert 실패: ${firstErr?.message}`);
    assert(first.korea_fit_score === 80, `generated korea_fit_score 가 80 이어야 함 (실제: ${first.korea_fit_score})`);
    console.log(`[ok] 첫 upsert: id=${first.id}, korea_fit_score=${first.korea_fit_score}`);

    // 4) 두 번째 upsert — id/created_at 보존, generated 값 갱신
    const secondInsert = {
      product_id: product.id,
      marketability_score: 71,
      marketability_description: "smoke v2",
      korea_market_fit: { fit_score: 55, target_products: [], recommended_channels: [] },
      live_commerce: { platforms: ["TikTok Live"], talking_points: [] },
      distribution_channels: [],
      pricing_strategy: { channel_pricing: [], bep_analysis: {} },
      marketing_strategy: [],
    };
    const { data: second, error: secondErr } = await sb
      .from("research_results")
      .upsert(secondInsert, { onConflict: "product_id" })
      .select("id, created_at, korea_fit_score")
      .single();
    if (secondErr || !second) throw new Error(`두 번째 upsert 실패: ${secondErr?.message}`);
    assert(second.id === first.id, "id 가 보존되어야 함");
    assert(second.created_at === first.created_at, "created_at 이 보존되어야 함");
    assert(second.korea_fit_score === 55, `generated 가 갱신되어야 함 (실제: ${second.korea_fit_score})`);
    console.log("[ok] 두 번째 upsert — id/created_at 보존, generated 갱신");
  } finally {
    // 5) 정리
    await sb.from("research_results").delete().eq("product_id", product.id);
    await sb.from("products").delete().eq("id", product.id);
    console.log("[ok] 임시 row 정리");
  }
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
```

(주의: `fetchColumns()` 는 supabase-js 가 information_schema 를 직접 못 읽기에 한 row 의 키를 보는 방식으로 우회. dev에 row가 0개면 빈 Map이 반환되어 false fail. 그 경우 빈 row 한 개 임시 생성하는 패턴으로 보강 가능. 백필이 끝난 dev 라면 row 가 최소 한 개는 있어야 정상.)

- [ ] **Step 2: package.json 스크립트 추가**

`package.json` 의 `"scripts"` 섹션에 한 줄 추가.

```json
"test:research-data-model": "tsx --env-file=.env.local scripts/test-research-data-model.ts"
```

(기존 `test:strategy-fresh-search` 등과 같은 줄 스타일로.)

- [ ] **Step 3: 실행 확인**

```bash
npm run test:research-data-model
```

기대 출력:
```
[ok] 신규 컬럼 6개 존재
[ok] 임시 product 생성: <uuid>
[ok] 첫 upsert: id=<uuid>, korea_fit_score=80
[ok] 두 번째 upsert — id/created_at 보존, generated 갱신
[ok] 임시 row 정리
```

`[FAIL]` 이 나오면 Migration 1 적용 여부 또는 `.env.local` 의 SERVICE_ROLE_KEY 확인.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-research-data-model.ts package.json
git commit -m "test(research): add live-DB smoke for Phase 1 data model

신규 5 jsonb 컬럼 + korea_fit_score(generated) 존재 확인,
research_results upsert 의 id/created_at 보존, generated column
재계산을 dev Supabase 에 직접 붙어서 검증한다."
```

---

## Task 4: `lib/research/synthesize-product.ts` — `buildResearchResultInsert` 확장 + upsert 전환

**Files:**
- Modify: `lib/research/synthesize-product.ts` (현재 `buildResearchResultInsert` line 82-107, delete-then-insert 호출 line 159-162 부근)

- [ ] **Step 1: 함수 위치 확인**

```bash
grep -n "buildResearchResultInsert\|delete()" lib/research/synthesize-product.ts
```

기대: `buildResearchResultInsert` 정의가 보이고, `synthesizeProductResearch` 안에서 `.delete().eq('product_id', ...)` 다음에 `.insert(...)` 가 호출되는 위치를 확인.

- [ ] **Step 2: `buildResearchResultInsert` 본문 교체**

기존 함수 본문을 다음으로 교체. (함수 시그니처가 다르면 보존하고 return 객체만 교체.)

```ts
function buildResearchResultInsert(
  productId: string,
  productInfo: ProductInfo,
  searchResults: Record<string, string>,
  research: ResearchOutput,
) {
  // korea_market_fit.fit_score 가 비숫자면 generated column 캐스팅이 실패하므로 정제.
  const koreaFit = research.korea_market_fit;
  if (koreaFit && typeof koreaFit === "object") {
    const raw = (koreaFit as { fit_score?: unknown }).fit_score;
    const num = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    (koreaFit as { fit_score?: number | null }).fit_score = Number.isFinite(num) ? num : null;
  }

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
    distribution_channels: research.distribution_channels,
    pricing_strategy: research.pricing_strategy,
    marketing_strategy: research.marketing_strategy,
    korea_market_fit: koreaFit,
    live_commerce: research.live_commerce,
    // raw_json 은 디버깅용 — research 본체는 컬럼으로 빠졌으니 중복 저장하지 않는다.
    raw_json: { product_info: productInfo, search_results: searchResults },
  };
}
```

- [ ] **Step 3: 저장 호출을 upsert로 교체**

기존 delete-then-insert 패턴이 보이는 곳 (대체로 다음 형태):

```ts
await sb.from('research_results').delete().eq('product_id', productId);
const { error: insertErr } = await sb.from('research_results').insert(insert);
```

→ 다음으로 교체:

```ts
const { error: upsertErr } = await sb
  .from('research_results')
  .upsert(insert, { onConflict: 'product_id' });
if (upsertErr) throw new ProductResearchSynthesisError(500, upsertErr.message);
```

(에러 변수 이름이 기존과 다르면 그에 맞춰 조정. 핵심은 `delete` 호출 제거와 `.insert` → `.upsert({ onConflict: 'product_id' })`.)

- [ ] **Step 4: 타입 체크 + smoke**

```bash
npx tsc --noEmit
npm run test:research-data-model
```

기대: 둘 다 통과. (smoke 는 Migration 1 이 적용된 dev 에서만 통과하므로 dev 적용을 먼저 확인.)

- [ ] **Step 5: Commit**

```bash
git add lib/research/synthesize-product.ts
git commit -m "feat(research): write extended sections to columns + upsert

buildResearchResultInsert 가 distribution_channels / pricing_strategy /
marketing_strategy / korea_market_fit / live_commerce 를 raw_json 대신
명시 컬럼에 저장. korea_market_fit.fit_score 는 정수 정제 후 저장해
generated column 캐스팅 실패를 방지. 저장 패턴은 delete-then-insert →
upsert(onConflict: product_id) 로 전환해 id/created_at 보존."
```

---

## Task 5: `app/api/analyze/route.ts` + `lib/discovery/promote-to-research.ts` — `'extracted'` → `'analyzing'`

extract 완료 시 status 를 `'extracted'` 가 아니라 `'analyzing'` 으로 유지한다. synthesize 가 곧이어 호출되므로 사용자/UI 입장에서는 하나의 "분석 중" 단계.

**Files:**
- Modify: `app/api/analyze/route.ts` (line 30 주석, line 40 `status: "extracted"`)
- Modify: `lib/discovery/promote-to-research.ts` (line 25 type literal, line 120 `status: "extracted"`)

- [ ] **Step 1: `app/api/analyze/route.ts` 수정**

line 30 부근 주석 + line 40 부근 `status: "extracted"` 두 곳을 교체.

```diff
- // Update product name, description, and metadata — status: extracted
+ // Update product name, description, and metadata — keep status: analyzing
...
- status: "extracted",
+ status: "analyzing",
```

- [ ] **Step 2: `lib/discovery/promote-to-research.ts` 수정**

line 25 의 type literal:

```diff
- 	status: "extracted";
+ 	status: "analyzing";
```

line 120 의 `status: "extracted"`:

```diff
- 		status: "extracted",
+ 		status: "analyzing",
```

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```

기대: 통과. (status union 에는 아직 `'extracted'` 가 남아있으므로 `'analyzing'` 도 당연히 허용.)

- [ ] **Step 4: Commit**

```bash
git add app/api/analyze/route.ts lib/discovery/promote-to-research.ts
git commit -m "refactor(lifecycle): write 'analyzing' instead of 'extracted'

extract 완료 시점에 status 를 'extracted' 로 한 차례 바꿨다가
synthesize 가 곧바로 다시 'analyzing' 으로 덮어쓰던 패턴을 제거.
사용자 입장에서는 분석 중 한 덩어리로 보이도록 일관화."
```

---

## Task 6: `app/[locale]/(document)/products/[id]/page.tsx` + `app/api/products/[id]/route.ts` — raw_json merge 제거 + `'extracted'` 제거

**Files:**
- Modify: `app/[locale]/(document)/products/[id]/page.tsx` (line 27 ProductStatus type, line 31 CSS map, line 38 validator, line 74-84 raw_json merge 블록)
- Modify: `app/api/products/[id]/route.ts` (line 32-38 동일한 raw_json merge)

- [ ] **Step 1: `app/[locale]/(document)/products/[id]/page.tsx` 의 raw_json merge 제거**

`getProduct` 함수 안 line 74-84 부근:

```diff
   const { data: research } = await sb
     .from('research_results')
     .select('*')
     .eq('product_id', id)
     .maybeSingle();

-  // Merge extended fields from raw_json.research (distribution_channels,
-  // live_commerce, etc.) — they have no dedicated DB columns. Mirrors the
-  // merge logic in app/api/products/[id]/route.ts.
-  let mergedResearch = research;
-  if (research?.raw_json?.research) {
-    const { raw_json, ...dbFields } = research;
-    const rawResearch = raw_json.research as Record<string, unknown>;
-    mergedResearch = { ...rawResearch, ...dbFields, raw_json };
-  }
-
-  return { product, research: mergedResearch };
+  return { product, research };
 }
```

- [ ] **Step 1b: `app/api/products/[id]/route.ts` 의 raw_json merge 제거**

line 32-38 부근의 같은 패턴(`let mergedResearch = research; if (research?.raw_json?.research) { ... }`) 을 동일하게 제거하고, response 가 머지된 `mergedResearch` 대신 원본 `research` 를 그대로 반환하도록 수정. 정확한 diff 는 파일을 열어 확인 후 `let mergedResearch` 선언부터 머지 블록 끝까지를 삭제하고 이후 `mergedResearch` 참조를 `research` 로 치환.

- [ ] **Step 2: `ProductStatus` 로컬 union 좁힘**

line 27 부근:

```diff
- type ProductStatus = 'pending' | 'extracted' | 'analyzing' | 'completed' | 'failed';
+ type ProductStatus = 'pending' | 'analyzing' | 'completed' | 'failed';
```

- [ ] **Step 3: CSS class map 정리**

line 31 부근의 `statusConfig` 또는 색상 매핑 객체에서 `extracted` 키를 제거.

```diff
-   extracted: 'bg-blue-600/15 text-blue-700 dark:text-blue-300 border-0',
```

- [ ] **Step 4: status validator 정리**

line 38 부근:

```diff
-   if (s === 'pending' || s === 'extracted' || s === 'analyzing' || s === 'completed' || s === 'failed') {
+   if (s === 'pending' || s === 'analyzing' || s === 'completed' || s === 'failed') {
```

- [ ] **Step 5: 타입 체크**

```bash
npx tsc --noEmit
```

기대: 통과.

- [ ] **Step 6: 수동 확인 — 기존 completed 상품의 리포트**

dev 환경에서 dev 서버 (`npm run dev`) 를 띄우고 기존 완료된 상품 한 건의 `/products/[id]` 페이지를 열어 5섹션 (Distribution / Pricing / Marketing / Korea / LiveCommerce) 이 모두 정상 렌더되는지 확인한다.

기대: 모든 섹션이 비어있지 않고(백필 적용된 row), PDF 다운로드도 정상.

- [ ] **Step 7: Commit**

```bash
git add app/[locale]/(document)/products/[id]/page.tsx
git commit -m "refactor(report): read 5 sections from columns + drop extracted state

raw_json.research spread 머지를 제거하고 신규 컬럼에서 직접 읽도록 변경.
로컬 ProductStatus 도 4단계로 좁히고 statusConfig/validator 의
'extracted' 분기 제거."
```

---

## Task 7: `components/ProductCard.tsx` + `components/ProductList.tsx` — UI hack 제거

**Files:**
- Modify: `components/ProductCard.tsx` (line 27 statusConfig key, line 96 이중 비교)
- Modify: `components/ProductList.tsx` (line 55 statusFilter OR 분기)

- [ ] **Step 1: `ProductCard.tsx` 의 `statusConfig.extracted` 제거**

line 27 부근의 `statusConfig` 객체에서 `extracted: { ... }` 항목을 제거. 객체 형태가 status별 icon/label/className 을 매핑하는 형태이므로 그 entry 만 삭제.

- [ ] **Step 2: `ProductCard.tsx` 의 이중 비교 정리**

line 96 부근:

```diff
- {(product.status === "analyzing" || product.status === "extracted") && (
+ {product.status === "analyzing" && (
```

- [ ] **Step 3: `ProductList.tsx` 의 statusFilter OR 분기 제거**

`filteredProducts` 의 `matchesStatus` 표현식 (line 53-55):

```diff
       const matchesStatus = statusFilter === 'all'
-        || p.status === statusFilter
-        || (statusFilter === 'analyzing' && p.status === 'extracted');
+        || p.status === statusFilter;
```

- [ ] **Step 4: 타입 체크**

```bash
npx tsc --noEmit
```

기대: 통과.

- [ ] **Step 5: 수동 확인 — 업로드 흐름 + 칩**

dev 서버에서 `/research` 페이지에 진입.
1. 새 파일을 업로드해서 카드가 `pending` → `analyzing` → `completed` 로 단계가 진행되는지 확인 (5초 폴링).
2. statusFilter chip (`all` / `completed` / `analyzing` / `pending` / `failed`) 를 각각 눌러 필터가 정상 동작하는지 확인.

기대: `extracted` chip 또는 라벨이 어디에도 보이지 않고, 새 업로드가 4단계만 거친다.

- [ ] **Step 6: Commit**

```bash
git add components/ProductCard.tsx components/ProductList.tsx
git commit -m "refactor(ui): drop extracted-state hack from ProductList/Card

statusConfig.extracted 와 statusFilter 의
'analyzing 이면 extracted 도 포함' OR 분기를 제거."
```

---

## Task 8: 테스트 픽스처 + i18n + `lib/supabase.ts` status union 좁힘 (마무리)

이제 `'extracted'` 리터럴이 남아 있는 모든 곳을 제거하고, 마지막으로 `Product.status` union 에서 `'extracted'` 를 빼낸다.

**Files:**
- Modify: `scripts/test-promote-to-research.ts` (line 51 assert)
- Modify: `scripts/test-recommendation-flow-readiness.ts` (line 88 fixture)
- Modify: `messages/ja.json` (line 796 `"extracted": "抽出済み"`)
- Modify: `messages/ko.json` (line 796 `"extracted": "추출 완료"`)
- Modify: `lib/supabase.ts` (Task 2 에서 남겨둔 `'extracted'` union 항목)

- [ ] **Step 1: test-promote-to-research.ts 픽스처 수정**

line 51 부근:

```diff
- assert.equal(insert.status, "extracted");
+ assert.equal(insert.status, "analyzing");
```

- [ ] **Step 2: test-recommendation-flow-readiness.ts 픽스처 수정**

line 88 부근:

```diff
- promotedProduct: { id: "p-1", name: "昇格商品", status: "extracted", discovered_product_id: "dp-1" },
+ promotedProduct: { id: "p-1", name: "昇格商品", status: "analyzing", discovered_product_id: "dp-1" },
```

- [ ] **Step 3: i18n `extracted` 키 제거**

`messages/ja.json` line 796 의 `"extracted": "抽出済み"` 줄을 삭제. JSON 문법 유지를 위해 앞/뒤 콤마 처리에 주의.

`messages/ko.json` line 796 의 `"extracted": "추출 완료"` 줄을 동일하게 삭제.

(이 키가 UI 어디에서 사용되는지 한 번 더 grep 해서 잔여 사용처 없는지 확인:)

```bash
grep -rn "t(['\"].*\.extracted['\"]" app components lib
```

기대: 매치 없음. 매치가 있다면 해당 호출도 함께 정리.

- [ ] **Step 4: `lib/supabase.ts` status union 좁힘**

Task 2에서 남겨둔 `'extracted' // deprecated` 라인을 제거.

```diff
 export type ProductStatus =
   | 'pending'
   | 'analyzing'
-  | 'extracted' // deprecated — Task 8/9 에서 제거됨. 그 전까지 컴파일 유지.
   | 'completed'
   | 'failed';
```

- [ ] **Step 5: 전체 `'extracted'` 잔재 검색**

```bash
grep -rn "'extracted'\|\"extracted\"" app lib components scripts messages
```

기대: 매치 없음 (i18n 의 다른 키나 자연어 `extracted from` 같은 false positive 제외).

- [ ] **Step 6: 타입 체크 + smoke + 픽스처 test**

```bash
npx tsc --noEmit
npm run test:promote-to-research
npm run test:recommendation-flow-readiness 2>/dev/null || npx tsx --env-file=.env.local scripts/test-recommendation-flow-readiness.ts
npm run test:research-data-model
```

기대: 모두 통과. (해당 test 명령이 package.json 에 없으면 직접 tsx 로 실행하는 형태가 fallback.)

- [ ] **Step 7: Commit**

```bash
git add scripts/test-promote-to-research.ts scripts/test-recommendation-flow-readiness.ts messages/ja.json messages/ko.json lib/supabase.ts
git commit -m "refactor(lifecycle): drop extracted from union, fixtures, i18n

ProductStatus union 에서 'extracted' 제거. 테스트 픽스처를 'analyzing'
으로 갱신하고, ja/ko i18n 의 status.extracted 라벨을 제거."
```

---

## Task 9: Migration 2 — `products_lifecycle_simplify.sql` 작성 + dev 적용

**Files:**
- Create: `supabase/migrations/2026-05-25_products_lifecycle_simplify.sql`

이 마이그레이션은 **Task 1~8 의 코드가 dev 에 배포된 뒤**에 적용한다. 코드가 이미 `'extracted'` 를 쓰지 않으므로 CHECK 제약을 좁혀도 in-flight 요청과 충돌하지 않는다.

- [ ] **Step 1: 마이그레이션 파일 작성**

```sql
-- 2026-05-25: products.status lifecycle 을 4단계로 좁힘.
-- 이 SQL 은 application code 가 이미 'extracted' 를 쓰지 않게 배포된 뒤에 적용한다.

-- 1) 잔존 row 정리 (찰나만 거치는 단계라 보통 0건이지만 방어적으로).
UPDATE products SET status = 'analyzing' WHERE status = 'extracted';

-- 2) CHECK 제약 갱신.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE products
  ADD CONSTRAINT products_status_check
  CHECK (status IN ('pending', 'analyzing', 'completed', 'failed'));
```

- [ ] **Step 2: dev 적용**

```bash
supabase db push
# 또는 SQL editor / psql 로 직접 적용
```

기대: 에러 없이 완료.

- [ ] **Step 3: 검증**

```sql
-- A. 잔존 'extracted' 가 없는지
SELECT COUNT(*) AS leftover FROM products WHERE status = 'extracted';
-- 기대: 0

-- B. CHECK 가 좁혀졌는지 — 다음 insert 가 실패해야 정상
INSERT INTO products (name, file_url, file_name, status)
VALUES ('check-test', 'x', 'x', 'extracted');
-- 기대: ERROR: new row violates check constraint "products_status_check"
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-25_products_lifecycle_simplify.sql
git commit -m "feat(lifecycle): tighten products.status CHECK to 4 states

코드가 이미 'extracted' 를 쓰지 않으므로 CHECK 제약을
('pending','analyzing','completed','failed') 로 좁힘.
잔존 'extracted' row 가 있으면 'analyzing' 으로 정리."
```

---

## Task 10: End-to-End 검증

새 코드 + 두 마이그레이션이 dev 에 모두 적용된 상태에서, 사용자 흐름을 처음부터 끝까지 따라간다.

- [ ] **Step 1: dev 서버 실행**

```bash
npm run dev
```

- [ ] **Step 2: `/research` 페이지 — 새 업로드 4단계 lifecycle 확인**

1. `/ja/research` 또는 `/ko/research` 진입.
2. PDF 또는 이미지 한 건을 업로드.
3. 카드 상태가 `pending` → `analyzing` → `completed` 로 진행하는지 5초 폴링으로 관찰.
4. statusFilter chip (`all` / `completed` / `analyzing` / `pending` / `failed`) 각각이 정상 동작하는지.

기대: `extracted` 라는 라벨/색/상태가 어디에도 보이지 않음. 4단계만 거침.

- [ ] **Step 3: 신규 상품의 `/products/[id]` 페이지 — 15섹션 모두 렌더**

`completed` 가 된 카드에서 "リポートを見る" 클릭 → 상세 페이지로 이동.

기대:
- Marketability / Demographics / Seasonality / COGS / Influencers / ContentIdeas / Competitor / BroadcastScript / JapanExport / DistributionChannel / PricingStrategy / MarketingStrategy / KoreaMarket / LiveCommerce / ResearchSources 모두 렌더.
- PDF 다운로드 정상.

- [ ] **Step 4: 기존 백필된 상품의 페이지 — 5섹션이 새 컬럼에서 정상 읽힘**

dev 에서 마이그레이션 1 이전에 합성된 적이 있는 상품 한 건을 골라 `/products/[id]` 진입.

기대: 위 4개 섹션 (Distribution / Pricing / Marketing / Korea / LiveCommerce) 이 raw_json merge 없이도 정상 렌더.

- [ ] **Step 5: SQL 인덱스 활용 확인**

dev DB 에서:

```sql
EXPLAIN ANALYZE
SELECT id, product_id, korea_fit_score
FROM research_results
WHERE korea_fit_score >= 70
ORDER BY korea_fit_score DESC
LIMIT 20;

EXPLAIN ANALYZE
SELECT id
FROM research_results
WHERE live_commerce @> '{"platforms":["Instagram Live"]}'::jsonb;

EXPLAIN ANALYZE
SELECT id
FROM research_results
WHERE marketing_strategy @> '[{"strategy":"インフルエンサーキャンペーン"}]'::jsonb;
```

기대 (각 쿼리에 대해):
- `Index Scan using idx_research_korea_fit_score`
- `Bitmap Index Scan on idx_research_live_commerce`
- `Bitmap Index Scan on idx_research_marketing_strategy`

(데이터가 적으면 planner 가 Seq Scan 을 택할 수 있다. 그 경우 인덱스 사용을 강제해서 (`SET enable_seqscan = off`) 인덱스 자체가 살아있음을 확인.)

- [ ] **Step 6: 재합성 시 id 보존 확인**

`scripts/test-research-data-model.ts` 가 이미 같은 시나리오를 검증하지만, 실사용 한 건도 확인.

dev 에서 한 상품의 `/api/analyze/synthesize` 를 두 번 트리거한 뒤 (예: 운영자가 직접 fetch with `Bearer ${CRON_SECRET}`):

```sql
SELECT id, product_id, created_at FROM research_results WHERE product_id = '<test-product-id>';
```

기대: row 가 하나만 존재하며 `created_at` 이 변하지 않음.

- [ ] **Step 7: 최종 정리 — verification 결과 기록**

이 시점에서 issue 가 발견되면 별도 follow-up commit. 발견 없으면 plan 완료.

(별도 commit 은 만들지 않는다. 이 단계는 manual verification 이라 코드 변경이 없다.)

---

## Production 배포 순서 (요약)

dev 에서 Task 1~10 이 모두 통과한 뒤 production 에 적용할 때의 순서는 다음과 같다 (spec §6 와 동일):

1. Production Supabase 에 **Migration 1** 적용 (`research_extended_columns.sql`).
2. 코드 PR 머지 + Vercel production 배포 (Task 2~8 의 코드 변경).
3. Production Supabase 에 **Migration 2** 적용 (`products_lifecycle_simplify.sql`).

각 단계 사이에 다음을 확인:
- 단계 1 적용 후: 백필 검증 SQL (Task 1 Step 3) 이 production 에서도 통과하는지.
- 단계 2 적용 후: 새 합성 한 건이 5섹션 컬럼에 정상 저장되는지, 기존 상품의 리포트 페이지가 정상 렌더되는지.
- 단계 3 적용 후: production 의 `products.status = 'extracted'` 가 없고 CHECK 제약이 4단계만 허용하는지.

---

## Out of Scope (다음 Phase)

- 합성 실패 재시도 / admin recovery UI / `analyzing` stuck 감지 cron / `CRON_SECRET ?? ""` 폴백 제거 → Phase 2 별도 spec/plan.
- Pro 모델 fallback / 다중 파일 분석 / extract prompt 언어 명시 → Phase 3.
- `product-files` 버킷 public 해제 / `/api/analyze` internal-only 강화 → Phase 4.
- 정밀 섹션 타입(`distribution_channels` 등의 nested 구조)을 `unknown` 에서 구체 타입으로 좁히기 → Phase 3 와 묶음 (Gemini `responseSchema` 강제와 함께).
- `raw_json.research` 잔재 제거 (`UPDATE ... SET raw_json = raw_json - 'research'`) → 디스크 절약이 필요해질 때 별도 마이그레이션.
