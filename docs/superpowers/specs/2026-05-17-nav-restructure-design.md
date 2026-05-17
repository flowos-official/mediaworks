# Nav Restructure — IA를 4그룹(자사/시장/제작/관리)으로 재구성

**Date:** 2026-05-17
**Status:** Approved (브레인스토밍 완료, 구현 plan 작성 대기)
**Scope:** UI/IA only. 기존 URL과 API는 모두 유지.

---

## 1. 문제

현재 top-nav는 `[홈]·[방송 캘린더]·[대본]·[매출 분석]·(admin) [사용자 관리]·[OA 수집 상태]` 구성이고, `[매출 분석]` 안에 4개 탭이 들어 있다.

| 탭 (`/analytics/...`) | 라벨 | 실제 내용 |
|---|---|---|
| `overview` | 概要 | 자사 매출 KPI 카드 + 트렌드 |
| `products` | 商品分析 | 자사 상품 매출 상세 |
| `discovery` | 商品発掘 | **외부** 신규 상품 후보 수집 |
| `strategy` | 戦略立案 | **외부** MD 추천 (신규 상품 추천) |

"매출 분석" 라벨 아래에 *과거 자사 매출*과 *미래 외부 시장 의사결정 도구*가 한 묶음이라 라벨–내용 mismatch가 크다. `[홈]`도 그룹 외부에 떠 있는 예외 지점이고, `[OA 수집 상태]`처럼 거의 안 쓰는 운영 도구가 top-nav를 차지하기도 했다 (이 PR 직전 별도 작업에서 이미 제거).

## 2. 결정한 IA — 4그룹

그룹핑 축은 **데이터 시야(자사 / 시장 / 운영)** 로 잡고 제작(콘텐츠 생산)을 한 축 더 분리한다.

```
[MediaWorks logo]   [자사 ▾]   [시장 ▾]   [제작 ▾]   [관리 ▾]   [언어]  [user]
```

| 그룹 | 멤버 | 대표(=그룹 라벨 클릭 시 이동) | i18n key |
|---|---|---|---|
| **자사** | 매출 개요 · 상품 분석 · 상품 이미지 | `/analytics/overview` | `nav.groups.firm` |
| **시장** | 방송 캘린더 · 신규 발굴 · 신규 추천 | `/broadcasts` | `nav.groups.market` |
| **제작** | 방송 대본 · 신규 리서치 | `/screenplays` | `nav.groups.produce` |
| **관리** *(admin only)* | 사용자 관리 · OA 수집 상태 · 스킬 레지스트리 | `/admin/users` | `nav.groups.admin` |

### 라우트 매핑
| 멤버 | URL (변동 없음, 1건 신설) |
|---|---|
| 매출 개요 | `/analytics/overview` |
| 상품 분석 | `/analytics/products` |
| 상품 이미지 | `/gallery` |
| 방송 캘린더 | `/broadcasts` |
| 신규 발굴 | `/analytics/discovery` (→ `/discovery/home`) |
| 신규 추천 | `/analytics/strategy` (→ `/strategy/expansion`) |
| 방송 대본 | `/screenplays` |
| **신규 리서치** | **`/research`** (신규 라우트, 현재 `/`의 업로드 UI 이전) |
| 사용자 관리 | `/admin/users` |
| OA 수집 상태 | `/admin/historical-crawl` |
| 스킬 레지스트리 | `/admin/registry` |

### 라벨 의도
- **자사 vs 시장** — 데이터 출처를 사용자에게 한눈에 전달.
- **신규 발굴 / 신규 추천** — 현재 라벨 `商品発掘 / 戦略立案`은 새로 들어온 사람에게 무엇을 하는 도구인지 안 보임. 사용자 가치(*무엇을 위한 도구인가*) 기준 라벨로 교체.
- **제작 그룹** — `방송 대본`을 단독 메뉴에서 빼서 `신규 리서치`와 묶으면 "신규 리서치 → 방송 기획 → 대본"이라는 자연스러운 콘텐츠 생산 파이프라인이 같은 dropdown에 모인다.
- **`[홈]` 제거** — 현재 홈은 "파일 업로드 + 최근 리서치 리스트" = 사실상 *개별 상품 리서치 진입점*이며 4그룹 어디에도 속하지 않는 예외였다. 업로드 UI는 의미상 *제작* 종속 → `/research`로 이동.

## 3. Nav UI 동작

### 그룹 노출 패턴
- **그룹 라벨 클릭** → 대표 페이지로 이동.
- **그룹 라벨 hover/focus** → dropdown 패널 표시, 멤버 전체 노출.
- 활성 상태 매칭: 현재 pathname(로케일 제거 후)이 그룹의 `pathPrefixes` 중 하나로 시작하면 그룹 라벨에 `text-blue-600 + 하단 underline`.

### 페이지 안 sub-nav
그룹 멤버 페이지 진입 시 페이지 상단에 sub-nav 탭(현재 `analytics/layout.tsx`의 탭과 동일한 시각 패턴) 노출.

### 모바일 (<768px)
top-nav는 햄버거 아이콘만. 클릭 시 전체 화면 시트가 열리고 4그룹을 `<details>` 형태로 펼침/접음.

### 로고 클릭 랜딩
- admin / member → `/analytics/overview` (자사 그룹 대표)
- viewer → `/analytics/products` (현재 동작과 동일)

### 역할별 노출
| 그룹 | viewer | member | admin |
|---|---|---|---|
| 자사 | dropdown 1-멤버(상품 분석)만, 그룹 클릭 시 `/analytics/products`로. UI 차원에서는 dropdown 대신 단일 링크 `[상품 분석]`만 노출. | 전체 | 전체 |
| 시장 | 숨김 | 전체 | 전체 |
| 제작 | 숨김 | 전체 | 전체 |
| 관리 | 숨김 | 숨김 | 전체 |

## 4. 코드 구조

### 4.1 단일 source of truth — `lib/nav/groups.ts` (신규)

```ts
import type { Role } from '@/lib/auth/route-permissions';

export type GroupKey = 'firm' | 'market' | 'produce' | 'admin';

export interface NavMember {
  labelKey: string;
  href: string;
}

export interface NavGroup {
  key: GroupKey;
  labelKey: string;
  landing: string;             // 그룹 라벨 클릭 시 이동
  pathPrefixes: string[];      // active matching
  members: NavMember[];
  // viewer는 'productsOnly' (members 중 /analytics/products만), 'full' (전체), 'hidden' (그룹 자체 숨김)
  visibility: Record<Role, 'full' | 'productsOnly' | 'hidden'>;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'firm',
    labelKey: 'nav.groups.firm',
    landing: '/analytics/overview',
    pathPrefixes: ['/analytics/overview', '/analytics/products', '/gallery'],
    members: [
      { labelKey: 'nav.firm.overview', href: '/analytics/overview' },
      { labelKey: 'nav.firm.products', href: '/analytics/products' },
      { labelKey: 'nav.firm.gallery',  href: '/gallery' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'productsOnly' },
  },
  {
    key: 'market',
    labelKey: 'nav.groups.market',
    landing: '/broadcasts',
    pathPrefixes: ['/broadcasts', '/analytics/discovery', '/analytics/strategy'],
    members: [
      { labelKey: 'nav.market.broadcasts', href: '/broadcasts' },
      { labelKey: 'nav.market.discovery',  href: '/analytics/discovery' },
      { labelKey: 'nav.market.strategy',   href: '/analytics/strategy' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'hidden' },
  },
  {
    key: 'produce',
    labelKey: 'nav.groups.produce',
    landing: '/screenplays',
    pathPrefixes: ['/screenplays', '/research'],
    members: [
      { labelKey: 'nav.produce.screenplays', href: '/screenplays' },
      { labelKey: 'nav.produce.research',    href: '/research' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'hidden' },
  },
  {
    key: 'admin',
    labelKey: 'nav.groups.admin',
    landing: '/admin/users',
    pathPrefixes: ['/admin/users', '/admin/historical-crawl', '/admin/registry'],
    members: [
      { labelKey: 'nav.admin.users',            href: '/admin/users' },
      { labelKey: 'nav.admin.historicalCrawl',  href: '/admin/historical-crawl' },
      { labelKey: 'nav.admin.registry',         href: '/admin/registry' },
    ],
    visibility: { admin: 'full', member: 'hidden', viewer: 'hidden' },
  },
] as const;
```

이 정의 하나에서 Navbar dropdown, 페이지 sub-nav, 활성 매칭 모두 파생. 그룹 멤버 변경 시 이 파일만 수정.

### 4.2 `/analytics` route group 분할

```
app/[locale]/analytics/
├── (firm)/
│   ├── layout.tsx              ← AnalyticsFilterContext + <FirmSubNav />
│   ├── overview/page.tsx       ← (이동만)
│   └── products/
│       ├── page.tsx
│       └── [code]/page.tsx
└── (market)/
    ├── layout.tsx              ← <MarketSubNav />, 필터 없음
    ├── discovery/...
    └── strategy/...
```

Next.js route group `(firm)`, `(market)`은 URL 영향 없음. `/analytics/overview` 등 모든 기존 URL 유지.

기존 `app/[locale]/analytics/layout.tsx`는 삭제. `AnalyticsFilterContext`는 `(firm)/layout.tsx`로 옮긴다. *검증 완료:* `useAnalyticsFilter` 사용처는 `analytics/overview/page.tsx`와 `analytics/products/page.tsx` 둘 뿐 (모두 자사 그룹) — `(market)` 그룹에 옮기는 페이지에서 컨텍스트를 쓰지 않음.

### 4.3 새 라우트 `/research`

- `app/[locale]/research/page.tsx`: 현재 `app/[locale]/page.tsx`의 내용을 그대로 이전.
- `app/[locale]/page.tsx`는 server-side redirect로 교체:
  ```ts
  // app/[locale]/page.tsx
  import { redirect } from 'next/navigation';
  import { localePath } from '@/lib/i18n/locale-path';
  import { getServerClient } from '@/lib/supabase/server';
  
  export default async function RootRedirect({ params }: { params: Promise<{ locale: string }> }) {
    const { locale } = await params;
    const sb = await getServerClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) redirect(localePath(locale, '/login'));
    const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    const role = profile?.role as 'admin' | 'member' | 'viewer' | undefined;
    redirect(localePath(locale, role === 'viewer' ? '/analytics/products' : '/analytics/overview'));
  }
  ```

### 4.4 Sub-nav cross-segment (`/broadcasts`)

`방송 캘린더`(`/broadcasts`)는 `analytics` segment 바깥에 있어 `(market)/layout.tsx`가 자동 상속되지 않는다. **선택안: 공유 컴포넌트 `<MarketSubNav />`를 `(market)/layout.tsx`와 `app/[locale]/broadcasts/page.tsx` 양쪽에서 렌더.** 멤버 정의는 `NAV_GROUPS`에 있으므로 drift 없음.

같은 패턴으로:
- `<FirmSubNav />`: `(firm)/layout.tsx` + `/gallery/page.tsx`
- `<ProduceSubNav />`: `/screenplays/page.tsx` + `/research/page.tsx`

### 4.5 신규/변경 파일

| 파일 | 액션 |
|---|---|
| `lib/nav/groups.ts` | **신규** |
| `components/Navbar.tsx` | 재작성 (dropdown 4개 + 모바일 시트 진입) |
| `components/nav/GroupDropdown.tsx` | **신규** |
| `components/nav/MobileNavSheet.tsx` | **신규** |
| `components/nav/FirmSubNav.tsx` | **신규** |
| `components/nav/MarketSubNav.tsx` | **신규** |
| `components/nav/ProduceSubNav.tsx` | **신규** |
| `app/[locale]/analytics/layout.tsx` | **삭제** |
| `app/[locale]/analytics/(firm)/layout.tsx` | **신규** (필터 + sub-nav) |
| `app/[locale]/analytics/(market)/layout.tsx` | **신규** (sub-nav만) |
| `app/[locale]/analytics/overview/...` → `(firm)/overview/...` | **이동** |
| `app/[locale]/analytics/products/...` → `(firm)/products/...` | **이동** |
| `app/[locale]/analytics/discovery/...` → `(market)/discovery/...` | **이동** |
| `app/[locale]/analytics/strategy/...` → `(market)/strategy/...` | **이동** |
| `app/[locale]/research/page.tsx` | **신규** (기존 `/`의 ProductList + FileUpload 이전) |
| `app/[locale]/page.tsx` | role-기반 redirect로 교체 |
| `app/[locale]/broadcasts/page.tsx` | 상단에 `<MarketSubNav />` 삽입 |
| `app/[locale]/screenplays/page.tsx` | 상단에 `<ProduceSubNav />` 삽입 |
| `app/[locale]/gallery/page.tsx` | 상단에 `<FirmSubNav />` 삽입 |
| `messages/ja.json`, `messages/ko.json` | 그룹/멤버 키 추가, 미사용 키 제거 |

### 4.6 i18n 키

아래는 "ja 값 / ko 값" 표기. 실제로는 `messages/ja.json`과 `messages/ko.json`에 각각 자기 값만 들어간다.

```jsonc
"nav": {
  "groups": {
    "firm":    "自社 / 자사",
    "market":  "市場 / 시장",
    "produce": "制作 / 제작",
    "admin":   "管理 / 관리"
  },
  "firm":    { "overview":   "売上概要 / 매출 개요",
               "products":   "商品分析 / 상품 분석",
               "gallery":    "商品ギャラリー / 상품 이미지" },
  "market":  { "broadcasts": "番組カレンダー / 방송 캘린더",
               "discovery":  "新規発掘 / 신규 상품 발굴",
               "strategy":   "MD戦略 / 신규 상품 추천" },
  "produce": { "screenplays":"番組台本 / 방송 대본",
               "research":   "新規リサーチ / 신규 리서치" },
  "admin":   { "users":            "ユーザー管理 / 사용자 관리",
               "historicalCrawl":  "OA収集状況 / OA 수집 상태",
               "registry":         "スキル登録 / 스킬 레지스트리" }
}
```

기존 `nav.home`, `nav.analytics`, `nav.broadcasts`, `nav.screenplays`, `nav.userManagement`는 마이그레이션 완료 후 제거. `nav.historicalCrawl`(`messages/{ja,ko}.json` 11행 부근)은 이번 PR 직전에 이미 제거됨 — 대신 `nav.admin.historicalCrawl`로 부활(top-nav에는 안 보이고 admin dropdown 안에만 노출되는 변경된 surface).

## 5. 단계적 롤아웃

각 단계는 독립 PR로 배포 가능.

| Step | 작업 | 가시 효과 |
|---|---|---|
| **1** | `lib/nav/groups.ts` 신설 + Navbar/dropdown/모바일시트 재작성. 페이지 layout은 미변경. | top-nav가 깨끗해짐. 페이지 안 sub-nav는 여전히 옛 4탭 (일관성 절반). |
| **2** | `analytics/layout.tsx` → `(firm)` / `(market)` 분할. `<FirmSubNav>`, `<MarketSubNav>` 부착. | 페이지 안 sub-nav가 그룹 정합. URL 영향 없음. |
| **3** | `/research` 신설 + `/`을 role redirect로 교체. | 외부 docs/즐겨찾기는 자동으로 자기 랜딩으로. |
| **4** | `/broadcasts`, `/screenplays`, `/gallery`에 cross-segment sub-nav 부착. | IA가 코드 표면 전체에 반영. |

Step 1 ↔ Step 2 사이는 일관성 절반만 깨진 *임시* 상태이므로, 같은 릴리스 사이클 안에 함께 배포(또는 최대 1~2일 갭)로 처리한다.

## 6. 리스크와 대응

1. **`useAnalyticsFilter` 컨텍스트 위치 이동 (Step 2)** — `(market)` 페이지에서 사용하면 provider null 에러. *검증 완료:* 사용처는 overview/products 두 곳뿐이며 모두 `(firm)`. **잔여 리스크: 없음.**
2. **`/` redirect의 비인증 경로** — middleware(`proxy.ts`)가 인증 redirect를 처리하지 않는 경우 페이지 안에서 `getServerClient` + null user 분기 필요. Step 3 PR에서 redirect 동작 수동 검증 필수.
3. **Sub-nav cross-segment drift** — `<MarketSubNav />`를 두 곳에서 렌더하지만 멤버 정의를 `NAV_GROUPS` 하나로 한정. 정의를 컴포넌트 안에 인라인하지 말 것.
4. **viewer dropdown UX** — viewer의 자사 그룹은 멤버 1개이므로 dropdown 대신 단일 링크 `[상품 분석]`로 노출. `GroupDropdown.tsx`에서 `visibility === 'productsOnly'`일 때 dropdown 비활성 + 직접 링크 렌더. 다른 그룹은 `'hidden'`이라 nav에서 통째로 빠지므로 viewer가 보는 top-nav는 사실상 `[상품 분석]` 단일 링크 + 로고.

## 7. 명시적 비포함 (YAGNI)

- 라우트 segment 자체 재작성 (`/firm/...`, `/market/...`) — URL 영향이 크고 이득이 작다.
- 새 대시보드 페이지 — 사용자 요청 범위 밖.
- 모바일 nav 고도화 (제스처, 애니메이션) — `<details>` 기반 단순 시트로 충분.
- 검색바, 알림, breadcrumb — 별도 작업.

## 8. 검증 계획

- TypeScript: `npx tsc --noEmit` (현재 baseline에 무관한 기존 에러 4건은 무시).
- 수동 검증 시나리오 (각 role로):
  1. 로고 클릭 → 자사 개요(admin/member) / 상품 분석(viewer)
  2. 자사 dropdown hover → 3개 멤버 (viewer는 1개 또는 단일 링크)
  3. `/broadcasts` 진입 → 상단 `[방송 캘린더 / 신규 발굴 / 신규 추천]` sub-nav 활성 매칭
  4. `/analytics/overview` 진입 → 필터 표시 + sub-nav 활성
  5. `/analytics/discovery` 진입 → 필터 안 보임, sub-nav만
  6. `/research` → 기존 홈 UI 정상 작동, 업로드 → `/products/[id]` 정상 이동
  7. 모바일 폭(<768px) → 햄버거 → 4그룹 펼침
  8. admin 외 role로 `/admin/*` 직접 URL 진입 → 401 또는 redirect (기존 인증 동작 유지 검증)
