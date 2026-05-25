# 신규 리서치 파이프라인 — 신뢰성·운영 (Phase 2)

> **작성일**: 2026-05-26
> **브랜치**: `research/reliability`
> **상위 로드맵**: Phase 1 (데이터 모델 정리, `5d2541f` 머지 완료) → **Phase 2 (이 문서, 신뢰성·운영)** → Phase 3 (출력 품질) → Phase 4 (보안, 옵션)

## 1. 배경 / 문제

Phase 1 이 끝난 뒤에도 다음 신뢰성 한계가 남아 있다:

- **`/api/upload` → `/api/analyze` → `/api/analyze/synthesize`** 가 fire-and-forget 체이닝. 두 번째·세 번째 호출이 cold-start 실패 / Vercel function invoke 실패 / Gemini 502 등으로 `pending` 또는 `analyzing` 상태에 영구히 stuck 될 수 있고, 코드가 이를 감지하지 못함. 사용자는 `ProductCard` 가 5초 폴링을 영원히 돌리는 모습만 본다.
- **`app/api/analyze/route.ts`** 가 `Bearer ${process.env.CRON_SECRET ?? ""}` 패턴을 사용. env 가 누락되면 빈 토큰으로 synthesize 를 호출 → silent 401 → 사용자에게는 `extracted` 직후 멈춤. extract 까지 성공했으니 ProductCard 는 진행 중처럼 보이지만 합성은 영원히 안 됨.
- **`app/api/cron/daily-refresh/route.ts`** 가 `research_results` upsert 시 5섹션 중 `live_commerce` 만 누락. Phase 1 final review 가 발견. 일일 새로고침이 도는 상품은 `live_commerce = null` 로 덮어쓰임.
- 합성 실패에 대한 사용자/관리자 recovery 경로 없음. 운영자가 SQL editor 에서 직접 `status='failed'` 인 row 를 보고 스크립트로 재시도해야 함 — UI 가 없어 발견·대응 속도가 느림.

## 2. 목표 / 비목표

### 목표
1. `pending` / `analyzing` 상태에서 10분 이상 머무르는 상품을 cron 으로 자동 감지하고 `status='failed'` + `error_reason` 으로 마킹.
2. 운영자가 `/admin/research-pipeline` 에서 현재 진행 중·실패 상품을 한 화면에 보고, 단계별 재시도를 한 클릭으로 트리거.
3. 재시도 시 시스템이 자동으로 어느 단계(extract / synthesize) 부터 다시 시작할지 판단 — 운영자는 단계 선택 안 함.
4. `CRON_SECRET ?? ""` silent fallback 제거 — env 누락 시 명시적 500 + `error_reason='cron_secret_missing'` 마킹.
5. `daily-refresh` cron 의 `live_commerce` 누락 회귀 수정.

### 비목표 (Phase 3 이후로 미룸)
- 사용자(viewer/member) 측 재시도 버튼 — 운영자만이 신뢰성 결정 권한.
- 진행 통보를 5초 polling 에서 SSE/Realtime 으로 개선 — Phase 3.
- Gemini Pro fallback / 다중 파일 / responseSchema — Phase 3.
- Storage 버킷 public 잠금 / `/api/analyze` internal-only 강화 — Phase 4.
- `pending` 단계의 fire-and-forget 자체를 durable workflow 로 바꾸는 것 (예: Vercel Workflow, Queue) — 본 spec 의 범위 밖. detection + retry 가 우선.

## 3. 데이터 모델 변경

### 마이그레이션 `supabase/migrations/2026-05-26_products_error_tracking.sql`

```sql
-- 2026-05-26: products 에 error_reason + updated_at 추가.
-- stuck detection cron 이 마지막 상태 변화 시각으로 stuck 판정.
-- error_reason 은 detection 시 (trigger_not_invoked / analysis_timeout) 와
-- analyze 라우트의 CRON_SECRET 누락 등 명시적 실패 케이스에서 채워진다.

BEGIN;

-- 1) 컬럼 추가 (idempotent — Phase 1 패턴 동일)
ALTER TABLE products ADD COLUMN IF NOT EXISTS error_reason text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 2) updated_at 자동 갱신 트리거 — 모든 UPDATE 가 updated_at 을 자동으로 now() 로 set.
--    명시적으로 updated_at 을 SET 해도 trigger 가 덮어씀 (의도된 동작).
CREATE OR REPLACE FUNCTION update_products_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at_trigger ON products;
CREATE TRIGGER products_updated_at_trigger
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION update_products_updated_at();

COMMIT;
```

### `lib/supabase.ts::Product` 타입 갱신
```ts
export type Product = {
  // ... 기존 필드 ...
  error_reason: string | null;
  updated_at: string;
  // ... 나머지 ...
};
```

## 4. 신규 cron — `/api/cron/research-stuck-detector`

**파일**: `app/api/cron/research-stuck-detector/route.ts`

**스케줄**: `*/15 * * * *` (15분마다, `vercel.json` 에 추가)

**인증**: `hasInternalSecret(request)` — 다른 cron 들과 동일.

**로직**:
```ts
// 1) pending 으로 10분+ stuck — analyze 트리거 자체 invoke 실패 의심
const { data: pendingStuck, count: pendingCount } = await sb
  .from('products')
  .update({ status: 'failed', error_reason: 'trigger_not_invoked' })
  .eq('status', 'pending')
  .lt('created_at', tenMinutesAgo)
  .select('id', { count: 'exact', head: false });

// 2) analyzing 으로 10분+ stuck — extract/synthesize 중 dead
const { data: analyzingStuck, count: analyzingCount } = await sb
  .from('products')
  .update({ status: 'failed', error_reason: 'analysis_timeout' })
  .eq('status', 'analyzing')
  .lt('updated_at', tenMinutesAgo)
  .select('id', { count: 'exact', head: false });

return NextResponse.json({
  ok: true,
  flagged: { pending: pendingCount, analyzing: analyzingCount },
});
```

`service_role` 클라이언트 사용 (RLS 우회). `updated_at` 트리거가 자동으로 새 시각 set.

**왜 10분?**: `vercel.json` 의 `maxDuration` 이 analyze 120s + synthesize 300s = 420s (7분). 10분이면 둘 다 정상 종료된 뒤이며 false positive 위험이 낮다.

## 5. 신규 Admin UI — `/admin/research-pipeline`

**파일**: `app/[locale]/admin/research-pipeline/page.tsx` (Server Component) + `components/admin/ResearchPipelineClient.tsx` (인터랙션)

**인증**: `requireUser(['admin'])`. `lib/auth/route-permissions.ts::VIEWER_ALLOWED_PATH_PREFIXES` 에 추가하지 않음.

**구성**:

```
/admin/research-pipeline

[수동 트리거]  ┌──────────────────────────────────────┐
              │ [지금 stuck 감지 실행]                │
              │ 마지막 cron 실행: 2026-05-26 10:15   │
              └──────────────────────────────────────┘

진행 중 (analyzing)  N건
┌─ 카드 ────────────────────────────────────────────┐
│ 상품명, 시작: HH:MM (X분 경과), [재시도] (수동 강제)│
└────────────────────────────────────────────────────┘

실패 (failed)  M건
┌─ 카드 ────────────────────────────────────────────┐
│ 상품명, error_reason, 시작: HH:MM, 실패: HH:MM    │
│ [재시도]                                            │
└────────────────────────────────────────────────────┘
```

**데이터**: Server Component 에서 `auth.sb` 로 `products WHERE status IN ('analyzing','failed') ORDER BY updated_at DESC LIMIT 100` 직접 조회.

**클라이언트 액션**: `useTransition` + `router.refresh()`. SSE 없이 단순 폼/버튼.

## 6. 신규 API

### `POST /api/admin/research-pipeline/retry`
**파일**: `app/api/admin/research-pipeline/retry/route.ts`

**인증**: `requireUser(['admin'])`.

**Body**: `{ productId: string }`

**로직**:
1. product 조회. status 가 `'failed'` 또는 `'analyzing'` 이 아니면 400 (재시도 불가능한 상태).
2. 단계 자동 판단:
   - `product.description IS NULL` → extract 부터. `/api/analyze` 를 `Bearer ${CRON_SECRET}` + base64 file 로 fire-and-forget 호출.
   - `product.description IS NOT NULL` → synthesize 만. `/api/analyze/synthesize` 동일.
3. `products` row 업데이트: `status='analyzing'`, `error_reason=null`. (`updated_at` 은 trigger 가 자동 set.)
4. 즉시 응답: `{ ok: true, retriedStage: 'extract' | 'synthesize' }`.

**에러 처리**: `CRON_SECRET` 누락 시 500 + 명시적 메시지.

### `POST /api/admin/research-pipeline/trigger-detection`
**파일**: `app/api/admin/research-pipeline/trigger-detection/route.ts`

**인증**: `requireUser(['admin'])`.

**로직**: stuck-detector cron 의 핵심 로직을 별도 모듈(`lib/research/stuck-detector.ts::detectStuck`) 로 추출하고, 이 라우트와 cron 라우트가 모두 import 해서 호출. cron 의존성 (`hasInternalSecret`) 우회.

## 7. 기존 코드 수정

### `app/api/analyze/route.ts` — `CRON_SECRET ?? ""` 제거

```diff
- const cronSecret = process.env.CRON_SECRET ?? "";
- fetch(`${baseUrl}/api/analyze/synthesize`, {
-   method: 'POST',
-   headers: {
-     'Content-Type': 'application/json',
-     Authorization: `Bearer ${cronSecret}`,
-   },
-   body: JSON.stringify({ productId }),
- }).catch(console.error);
+ const cronSecret = process.env.CRON_SECRET;
+ if (!cronSecret) {
+   console.error('[/api/analyze] CRON_SECRET missing — synthesize call blocked');
+   await sb.from('products').update({
+     status: 'failed',
+     error_reason: 'cron_secret_missing',
+   }).eq('id', productId);
+   return NextResponse.json({ error: 'CRON_SECRET missing' }, { status: 500 });
+ }
+ fetch(`${baseUrl}/api/analyze/synthesize`, {
+   method: 'POST',
+   headers: {
+     'Content-Type': 'application/json',
+     Authorization: `Bearer ${cronSecret}`,
+   },
+   body: JSON.stringify({ productId }),
+ }).catch(console.error);
```

같은 라우트 내 `/api/upload → /api/analyze` 트리거에도 동일 패턴이 있으면 같이 정리. grep 으로 확인 후 모든 `?? ""` 폴백 제거.

### `app/api/cron/daily-refresh/route.ts` — `live_commerce` 누락 수정

`research_results` upsert 객체에 누락된 `live_commerce` 컬럼 추가. Phase 1 의 final review 가 발견한 한 줄 회귀 수정.

### `lib/research/synthesize-product.ts` — catch 에서 `error_reason` 마킹

기존 try/catch 가 실패 시 `status='failed'` 만 set. `error_reason` 도 함께 채워서 admin UI 가 어떤 단계에서 무엇 때문에 실패했는지 한 화면에 보이게 함.

```diff
 } catch (error) {
   await sb.from('products')
-    .update({ status: 'failed' })
+    .update({
+      status: 'failed',
+      error_reason: error instanceof Error
+        ? `synthesis_failed: ${error.message.slice(0, 500)}`
+        : 'synthesis_failed: unknown',
+    })
     .eq('id', productId);
   throw error;
 }
```

`app/api/analyze/route.ts` 의 extract catch 도 동일 패턴 (`'extract_failed: ${err.message}'`) 적용.

## 8. RLS / 라우트 권한

- 신규 cron `/api/cron/research-stuck-detector`: `hasInternalSecret()` 게이트만 (기존 cron 라우트 패턴).
- 신규 admin route 2개 (`retry`, `trigger-detection`): `requireUser(['admin'])`.
- 신규 admin 페이지 `/[locale]/admin/research-pipeline`: `requireUser(['admin'])`. viewer 차단.
- `lib/auth/route-permissions.ts::VIEWER_ALLOWED_PATH_PREFIXES` 변경 없음 — admin 페이지는 viewer 가 보면 안 됨.

## 9. Cron 등록 — `vercel.json`

```diff
   "crons": [
     // ... 기존 crons ...
+    { "path": "/api/cron/research-stuck-detector", "schedule": "*/15 * * * *" }
   ]
```

## 10. 검증 / smoke

### `scripts/test-research-stuck-detector.ts`

dev Supabase 에 직접 붙어서 다음 검증:

1. 임시 product row insert: status='pending', created_at = now() - 11분
2. 두 번째 임시 row: status='analyzing', updated_at = now() - 11분 (또는 row insert 후 updated_at 강제 UPDATE)
3. `detectStuck()` 함수 직접 호출 (lib/research/stuck-detector.ts 의 export)
4. 두 row 모두 `status='failed'` + 적절한 `error_reason` 으로 전환 확인
5. 정상 row (시간 안 흐른 것) 는 변하지 않음 확인
6. 정리 (DELETE)

`package.json` 에 `"test:research-stuck-detector": "tsx --env-file=.env.local scripts/test-research-stuck-detector.ts"` 추가.

### `scripts/test-research-retry.ts` (옵션)

retry API 의 단계 판단 로직만 검증 (실제 HTTP 호출 없이 `lib/research/retry-stage.ts::determineRetryStage(product)` 같은 순수 함수로 추출 + 단위 검증).

### Phase 1 의 smoke 영향 없음 확인
- `npm run test:research-data-model` 통과 유지 (`updated_at` / `error_reason` 추가가 기존 흐름에 영향 없는지).

## 11. 배포 순서

1. Migration `2026-05-26_products_error_tracking.sql` → dev 적용 → smoke 통과 확인 → prod 적용.
2. 코드 배포 (cron + admin UI + analyze CRON_SECRET fix + daily-refresh fix + TS 타입 + smoke 스크립트 + `vercel.json` cron 추가).
3. Vercel 배포 직후 cron 활성 — 다음 15분 사이에 첫 detection 실행. 운영자가 `/admin/research-pipeline` 에서 결과 확인.

## 12. 리스크 / 미해결

- **`updated_at` trigger 충돌**: 기존 코드가 `updated_at` 를 명시적으로 SET 하는 곳이 있다면 trigger 가 override 함. mediaworks 의 다른 테이블 (`broadcasts`, `discovered_products`) 는 trigger 없이 application 측에서 `updated_at = new Date().toISOString()` 으로 채우는 패턴이 있음. trigger 도입은 일관성 측면에서 신중. **mitigation**: trigger 가 안전한 default 이고, 명시 SET 도 정상 동작 (override 가 그게 그것). 다만 기존 패턴과의 일관성을 위해 trigger 없이 application 측에서 `updated_at` 을 set 하는 대안도 고려 가능. 본 spec 에서는 trigger 채택 (단일 진실 공급원).
- **10분 threshold 부족**: 극단적인 Gemini 503 retry 로 정상 in-flight 가 10분 넘는 케이스. 현재 `synthesizeResearch` 가 attempt 2 회 (`gemini.ts:460-481`) 라 최대 ~10분 가능. **mitigation**: 운영자가 `/admin/research-pipeline` 에서 false positive 발견 시 수동 재시도 (idempotent).
- **재시도 후 다시 stuck**: retry API 가 fire-and-forget 으로 analyze/synthesize 를 호출한 뒤 또 invoke 실패하면 다시 pending/analyzing 으로 머무름. 다음 cron 사이클 (15분 후) 에 다시 failed 마킹. 무한 루프 없음 (운영자가 직접 트리거하는 한). cron 이 자동 재시도하지 않으므로 안전.
- **`error_reason` 길이 제한**: text 타입이라 제한 없음. catch 한 stack trace 가 길어도 OK. 다만 UI 에서는 truncate 권장.
- **Phase 2 적용 후 Phase 3 의 Pro fallback 미적용 상태**: synthesize 가 flash 2회 실패하면 그대로 throw → 새 catch 가 status='failed' + error_reason='synthesis_failed' 으로 마킹하도록 `synthesizeProductResearch` 도 살짝 보강해야 함. **이 spec 에 포함**: synthesize-product.ts 의 try/catch 에서 throw 전 `error_reason` 도 같이 set.

## 13. 영향 없는 영역 (의도적 비변경)

- 사용자 측 `ProductCard`, `ProductList`, `/research`, `/products/[id]` — 변경 없음. failed badge 는 기존 그대로.
- Discovery / Strategy / Broadcasts / Pipeline 모듈 — 영향 없음.
- Phase 1 의 마이그레이션 / 컬럼 / 타입 / smoke — 변경 없음.

## 14. 후속 (Phase 3 으로)

- Pro fallback 은 사용자가 명시적으로 "제외" 했으므로 도입 안 함. 대신 flash 모델의 retry 전략 강화 (별도 wait + exponential backoff) 가 Phase 3 의 출력 품질 작업과 묶일 수 있음.
- 사용자 측 진행 통보 (SSE/Realtime) — 동일.
- 다중 파일 처리 / extract prompt 언어 명시 / responseSchema — Phase 3 의 출력 품질 핵심.
