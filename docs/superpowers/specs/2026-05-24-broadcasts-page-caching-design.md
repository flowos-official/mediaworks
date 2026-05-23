# /broadcasts 페이지 캐싱 설계 (Cache Components PoC)

- 작성일: 2026-05-24
- 범위: `app/[locale]/(market)/broadcasts/page.tsx` 한 페이지 한정 (PoC)
- 후속: 효과 측정 후 `/analytics/discovery/home`, `/products/[id]` 등으로 확장 검토

## 1. 배경 & 목적

`/broadcasts` 페이지는 RSC에서 페이지 1회 접속마다 Supabase를 11회 호출한다:

- `aggregateCalendarCounts(sb, from, to)` — 선택된 달 ± 양옆 일부의 일별·채널별 broadcast/historical_broadcasts 카운트 (내부에서 페이지네이션 chunking, 최악 200 chunk × 2 테이블)
- QVC + ShopCh 전체 카운트 (2 쿼리, `count: exact, head: true`)
- 8개 OA 채널 전체 카운트 (8 쿼리, 동일)

데이터는 cron 1회/일 (`daily-broadcasts`, `daily-historical-broadcasts`) + 1회/일 (`qvc-monthly-refresh`) 로만 갱신된다. 사용자 접속 횟수에 비해 데이터 변경 빈도가 매우 낮아 캐싱 효과가 크다.

목표: **사용자 접속당 Supabase read를 0회 (auth 제외)** 로 줄이는 것.

## 2. 비목표 (Non-goals)

- PPR (Partial Prerendering) 활성화 — 추후 별도 검토
- `/broadcasts` 외 페이지 적용 — 별도 spec
- 관리자 수동 액션(`/api/broadcasts/refresh`, `/api/broadcasts/analyze-fit`)의 즉시 캐시 무효화 — 6h 안전망에 의존, UX 정책으로 합의됨
- 클라이언트 측 SWR/React Query 도입 — 서버 캐싱만으로 충분
- 자동화 테스트 추가 — Next.js 런타임 책임 영역, 빌드 통과 + 수동 검증으로 충분

## 3. 사용자 합의 사항

브레인스토밍 단계에서 확정:

| 항목 | 결정 |
|---|---|
| Scope | `/broadcasts` 한 페이지 (PoC) |
| 신선도 정책 | Cron 종료 시 자동 무효화. 관리자 수동 액션은 최대 6h stale 허용 |
| 접근법 | A — `use cache` 디렉티브 최소 적용 (PPR 미적용) |
| RLS vs cache | 캐시드 함수는 service-role client 사용. 인증은 페이지 진입 게이트에서 처리 |
| 부분 결과 정책 | `aggregateCalendarCounts`의 break-on-error 동작 그대로 유지. 빈 결과도 캐시됨, empty state UI로 노출, 6h 안전망 회수 |
| 테스트 | 자동화 신규 없음. 빌드 + 프로덕션 수동 검증 |

## 4. 아키텍처

```
app/[locale]/(market)/broadcasts/page.tsx
  ├─ requireUser(["member","admin"])         ← 캐시 밖 (per-request)
  ├─ getCachedCalendarCounts(from, to)       ← 'use cache'
  └─ getCachedChannelTotals()                ← 'use cache'

lib/broadcasts/cached.ts                     ← 신규
  ├─ getCachedCalendarCounts(from, to)
  └─ getCachedChannelTotals()

lib/broadcasts/aggregate-counts.ts           ← 시그니처 변경
  └─ aggregateCalendarCounts(from, to)
       ※ SupabaseClient 인자 제거, 내부에서 service client 사용

lib/broadcasts/jst-date.ts                   ← 신규 (cron 공용 헬퍼)
  ├─ getYesterdayJST(): Date
  └─ getJSTYearMonth(d: Date): string  // "YYYY-MM"

app/api/cron/daily-broadcasts/route.ts             ← 끝에 revalidateTag 추가 + jst-date 헬퍼로 치환
app/api/cron/qvc-monthly-refresh/route.ts          ← 동일
app/api/cron/daily-historical-broadcasts/route.ts  ← 동일
```

### 4.1 핵심 결정

1. **캐시드 함수 내부에서 `getServiceClient()` 사용 (RLS 우회).** `/broadcasts`는 `requireUser(["member","admin"])`로 페이지 게이트가 걸려 있고, member/admin이 보는 broadcasts 데이터는 동일하므로 사용자 차원의 캐시 분리 불필요. 캐시 히트율 최대화.
2. **`aggregateCalendarCounts` 시그니처 변경.** `'use cache'` 함수의 인자는 직렬화 가능해야 하므로 `SupabaseClient`를 인자로 받지 않고 내부에서 생성. 호출처는 페이지 한 곳뿐이라 마이그레이션 안전.
3. **인증 게이트는 캐싱 대상 아님.** `requireUser`는 per-request로 실행되어 미인증 사용자 진입을 막는다.
4. **`server-only` import.** 캐시드 모듈에 `import 'server-only'`를 최상단에 두어 클라이언트 번들 유입을 컴파일 단계에서 차단.

## 5. 캐시 키 & 무효화

### 5.1 캐시 함수 사양

| 헬퍼 | `cacheTag` | `cacheLife` |
|---|---|---|
| `getCachedCalendarCounts(from: string, to: string)` | `broadcasts:calendar:${from.slice(0,7)}` | `{ revalidate: '6h', expire: '24h' }` |
| `getCachedChannelTotals()` | `broadcasts:totals` | `{ revalidate: '6h', expire: '24h' }` |

- 함수 인자는 캐시 키에 자동 포함됨 (Next.js Cache Components 동작).
- `getCachedCalendarCounts`의 태그는 `from`의 YYYY-MM 기준 하나로 통일. 페이지의 `monthBoundsAround(selected)`는 양옆 7일을 끼워 넣기 때문에 엄밀히 한 달 경계는 아니지만, 6h `revalidate` 안전망이 경계 부분의 stale 노출을 자연 회수.

### 5.2 무효화 체인

| Cron | 시각 (UTC) | 영향 받는 데이터 | 호출할 무효화 |
|---|---|---|---|
| `/api/cron/daily-broadcasts` | 16:00 | qvc + shopch slot insert (어제 JST) | `revalidateTag("broadcasts:calendar:${어제JST YYYY-MM}")` + `revalidateTag("broadcasts:totals")` |
| `/api/cron/qvc-monthly-refresh` | 17:00 | QVC 지난달 + 이번달 재스크랩 | 두 YYYY-MM 태그 + `broadcasts:totals` |
| `/api/cron/daily-historical-broadcasts` | 16:30 | OA 8채널 historical_broadcasts insert (어제 JST) | `broadcasts:calendar:${어제JST YYYY-MM}` + `broadcasts:totals` |

- 호출 위치: 각 cron 함수 종료 직전, `console.log(JSON.stringify(log))` 직전.
- 어제 JST 날짜 / JST 이번달 산출 헬퍼는 `lib/broadcasts/jst-date.ts`로 추출 (현재 `daily-broadcasts/route.ts` 내부 로컬 함수 + `qvc-monthly-refresh/route.ts`의 `jstNow()` 가 비슷한 로직을 각자 정의 중). 신규 helper: `getYesterdayJST(): Date`, `getJSTYearMonth(d: Date): string` (`"YYYY-MM"`).
- `qvc-monthly-refresh`는 `jstNow()`로부터 이번달 + 지난달 YYYY-MM을 직접 도출해 두 태그 무효화.

### 5.3 데이터 플로우

캐시 히트 시:

```
User → /broadcasts?date=2026-05-15
  → requireUser(...)                            [auth 1회]
  → getCachedCalendarCounts("2026-04-25","2026-06-07")
      → cache HIT                                [DB 0회]
  → getCachedChannelTotals()
      → cache HIT                                [DB 0회]
  → BroadcastCalendar render
```

캐시 미스 시 (첫 접속 / cron 직후): 기존과 동일하게 11회 Supabase 호출.

## 6. 에러 처리 & 안전망

| 시나리오 | 처리 |
|---|---|
| Cache HIT인데 데이터가 stale (cron 실패 / 무효화 누락) | `cacheLife.revalidate: '6h'` 가 SWR 백그라운드 재페치. cron 자체 모니터링은 기존 `historical_crawl_runs` + `/admin/historical-crawl`에 위임 |
| `revalidateTag` 호출 자체 실패 | `try/catch`로 감싸고 `console.warn("[cache] revalidateTag failed", { tag, error })` 만 남김. cron은 200 정상 반환 |
| 캐시 함수 내부 Supabase 호출 실패 | 기존 `aggregateCalendarCounts`의 break-on-error 동작 유지. 부분/빈 결과도 캐시됨 → empty state UI로 노출 → 6h 회수. YAGNI |
| service-role client의 클라이언트 노출 | 캐시드 모듈 최상단 `import 'server-only'` + `'use cache'` 자체가 서버 전용 |
| Stampede | `revalidateTag`는 즉시 캐시를 비울 뿐 다음 요청 1회만 페치. cron 빈도가 낮아 stampede 위험 없음 |

## 7. 검증

### 7.1 로컬

- `npm run build` — `'use cache'` 정적 분석 통과 확인 (비직렬화 인자 같은 실수 검출)
- `npx tsc --noEmit` — 타입 체크

### 7.2 프로덕션 (배포 후)

브라우저 DevTools Network + Supabase 대시보드 read 카운트로 측정:

| 시나리오 | 기대 |
|---|---|
| `/broadcasts` 첫 진입 (캐시 miss) | 11회 Supabase 호출 (기존 동일) |
| 같은 달 재진입 (캐시 hit) | 0회 |
| 다른 달 이동 (다른 캐시 키) | 11회 |
| cron 수동 트리거 직후 `/broadcasts` 진입 | 해당 월 + totals 페치 발생 |
| 그 다음 새로고침 | 0회 |

### 7.3 회귀 방지

- 기존 `npm run test:broadcasts-parsers` 통과 확인 (캐싱과 무관).
- 자동화 신규 테스트는 추가하지 않음.

## 8. 마이그레이션 / 롤백

- 모든 변경이 추가 모듈(`lib/broadcasts/cached.ts`) + 시그니처 변경(`aggregate-counts.ts`) + cron 라인 추가(3 파일). 페이지 코드는 두 함수 호출로 교체만.
- 롤백: 페이지를 이전 직접 쿼리 버전으로 되돌리면 즉시 비캐싱 동작 복귀. `cached.ts` / cron 무효화 라인을 남겨두어도 무해.

## 9. 후속 (out of scope)

- `/analytics/discovery/home` — 현재 `"use client"`. 캐시 적용하려면 RSC 전환 또는 `/api/discovery/today`에 HTTP/Runtime Cache 적용. 별도 spec.
- `/products/[id]` — research 결과는 사실상 불변, `cacheLife({ expire: '1y' })` 후보.
- PPR 도입 — `/broadcasts` 효과 확인 후 검토.
