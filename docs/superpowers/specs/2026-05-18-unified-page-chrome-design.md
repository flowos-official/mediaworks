# Unified Page Chrome — 모든 화면을 동일한 group-layout 구조로 통일

**Date:** 2026-05-18
**Status:** Approved (브레인스토밍 완료, 구현 plan 작성 대기)
**Scope:** UI/IA chrome 통일. NAV_GROUPS 데이터 변경 없음. 모든 기존 URL 유지.

---

## 1. 문제

`2026-05-17-nav-restructure` 작업으로 top-nav 4그룹(자사/시장/제작/관리)은 정리됐지만, 각 페이지의 **chrome 구조가 4가지 패턴으로 갈라져 있다**.

| 패턴 | 페이지 | chrome 구성 |
|---|---|---|
| A. group layout | `/analytics/overview`, `/analytics/products` (firm) / `/analytics/discovery/*`, `/analytics/strategy/*` (market) | layout이 PageHeader + SubNav 제공 |
| B. SubNav 수동 import + page header 자체 작성 | `/screenplays`, `/research` (produce) | 페이지마다 다른 header(badge·정렬·폰트) |
| C. chrome 없음 | `/admin/users`, `/admin/historical-crawl`, `/admin/registry` | sub-nav 자체가 없음 |
| D. 그룹 외부에서 SubNav만 빌려옴 | `/broadcasts` (market), `/gallery` (firm) | group header 누락, 수동 import |

추가로 거의 동일한 SubNav 컴포넌트가 3개 존재한다 (`FirmSubNav`, `MarketSubNav`, `ProduceSubNav`). 차이는 `NAV_GROUPS`에서 어느 그룹을 바인딩하느냐뿐.

### 사용자 영향
- 관리 페이지에서는 다른 관리 화면으로 이동하는 sub-nav가 없어 매번 top-nav 드롭다운을 열어야 함.
- 같은 그룹의 페이지인데 일부는 그룹 헤더가 있고 일부는 없음 → "내가 지금 어느 섹션에 있지?"가 불분명.
- 페이지마다 H1 스타일·정렬·서브타이틀이 달라 일관성 떨어짐.

### 코드 영향
- 3개의 near-duplicate SubNav (FirmSubNav/MarketSubNav/ProduceSubNav).
- (produce), (admin) route group 부재로 페이지마다 chrome 보일러플레이트 중복.
- 새 페이지 추가 시 "chrome을 어디 그리느냐"가 페이지마다 다르므로 패턴 학습 비용 발생.

## 2. 결정한 모델 — Group Layout (안 A)

```
┌────────────────────────────────────────────────────────────┐
│ Navbar (logo · 그룹 드롭다운 · LanguageSwitcher · UserMenu)  │  ← app/[locale]/layout.tsx (변경 없음)
├────────────────────────────────────────────────────────────┤
│  📊 그룹 제목                                                │  ← <PageHeader>  (group layout)
│  서브타이틀                              ┌ action slot ─┐  │
│                                          │ DateRange 등   │  │
│                                          └─────────────────┘  │
├────────────────────────────────────────────────────────────┤
│  [ 멤버1 ] [ 멤버2 ] [ 멤버3 ]                              │  ← <GroupSubNav>  (group layout)
├────────────────────────────────────────────────────────────┤
│                                                              │
│                       page content                           │  ← page.tsx (콘텐츠만)
│                                                              │
└────────────────────────────────────────────────────────────┘
```

4그룹 모두 동일한 구조. 페이지는 콘텐츠만 담당한다.

### 채택 이유
- 기존 (firm), (market) layout이 이미 같은 모델 → **확장만 하면 됨**. 새 패턴을 도입하지 않는다.
- 관리 그룹이 처음으로 sub-nav를 가져 navigability가 개선됨.
- SubNav 컴포넌트를 generic 1개로 통합 → DRY.
- 사이드바(B안) 또는 헤더 제거(C안) 같은 큰 재설계 없이 점진 적용 가능.

### 거부한 대안
- **B. 좌측 사이드바**: Navbar 통째로 재설계, broadcasts 캘린더가 가로 공간 손해.
- **C. Sub-tab만 (헤더 제거)**: 페이지마다 H1을 다시 적게 돼 결국 헤더가 부활.

## 3. 컴포넌트 인벤토리

| 컴포넌트 | 역할 | 상태 |
|---|---|---|
| `<PageHeader icon title subtitle action?>` | 아이콘 + 제목 + 서브타이틀 + 우측 action slot | **신규 generic** |
| `<GroupSubNav groupKey>` | `NAV_GROUPS`에서 멤버 읽어 segmented tabs 렌더 (현재 SubNav들과 동일한 스타일) | **신규 generic** |
| `(firm)/layout.tsx` | PageHeader("自社データ", BarChart3) + GroupSubNav(firm) + DateRangeFilter를 action slot에 주입 | 리팩토 (기존 존재) |
| `(market)/layout.tsx` | PageHeader("市場リサーチ", Globe2) + GroupSubNav(market) | 리팩토 (기존 존재) |
| `(produce)/layout.tsx` | PageHeader("制作", Clapperboard) + GroupSubNav(produce) | **신규** |
| `(admin)/layout.tsx` | PageHeader("管理", Settings) + GroupSubNav(admin) | **신규** |
| `(document)/layout.tsx` | Navbar만 + breadcrumb slot. 깊은 단일 문서 전용 | **신규** (현재 layout 없음) |
| `FirmSubNav` / `MarketSubNav` / `ProduceSubNav` | — | **삭제** |
| `DateRangeFilter` | firm layout이 PageHeader의 action slot에 주입 | 위치만 이동 (컴포넌트 자체 변경 없음) |
| `MobileNavSheet` | 모바일 햄버거 — 변경 없음 | 그대로 |

### `<PageHeader>` 시그니처
```tsx
interface PageHeaderProps {
  icon: LucideIcon;        // 그룹 아이콘
  title: string;            // 그룹 제목 (i18n로 호출자가 해결)
  subtitle?: string;        // 서브타이틀
  action?: ReactNode;       // 우측 슬롯 (DateRangeFilter 등)
}
```
서버 컴포넌트로 작성 가능. action이 client 컴포넌트라도 children pattern으로 working.

### `<GroupSubNav>` 시그니처
```tsx
interface GroupSubNavProps {
  groupKey: GroupKey;       // 'firm' | 'market' | 'produce' | 'admin'
}
```
내부에서 `usePathname()` + `findActiveMember()`로 active 멤버 계산. `useTranslations()`로 라벨 i18n. 스타일은 기존 SubNav들과 1:1 동일하게 시작(`p-1 bg-white border rounded-xl shadow-sm`, active = `bg-blue-600 text-white`).

## 4. 라우트 재배치

App Router의 route group `(name)`은 URL에 영향을 주지 않으므로, **모든 기존 URL과 북마크가 그대로 동작**한다.

```
app/[locale]/
├── (firm)/                        ← layout: 自社データ + DateRangeFilter + SubNav
│   ├── analytics/overview/        ← 이동 (기존 analytics/(firm)/overview)
│   ├── analytics/products/        ← 이동 (기존 analytics/(firm)/products)
│   └── gallery/                   ← 이동, FirmSubNav 수동 import 삭제
├── (market)/                      ← layout: 市場リサーチ + SubNav
│   ├── broadcasts/                ← 이동, MarketSubNav 수동 import 삭제
│   ├── analytics/discovery/       ← 이동 (전 history/home/insights/live/page/session)
│   └── analytics/strategy/        ← 이동 (전 expansion/live/page)
├── (produce)/                     ← layout 신규
│   ├── screenplays/               ← 이동 (전 page + new + [id]), ProduceSubNav 수동 import 삭제
│   └── research/                  ← 이동, ProduceSubNav 수동 import 삭제
├── (admin)/                       ← layout 신규
│   └── admin/
│       ├── users/                 ← 이동, 자체 h1 삭제 (group header가 대체)
│       ├── historical-crawl/      ← 이동
│       └── registry/              ← 이동 (전 page + [skillSlug])
├── (document)/                    ← layout 신규: Navbar만 + breadcrumb slot
│   └── products/[id]/             ← 이동 — 13섹션 리서치 리포트
├── analytics/page.tsx             ← 유지 (redirect to /analytics/overview)
├── layout.tsx                     ← 변경 없음 (NextIntlClientProvider + Navbar)
├── page.tsx                       ← 변경 없음 (root redirect)
├── login/                         ← 변경 없음 (Navbar는 logged-out 분기로 자체 처리)
└── reset-password/                ← 변경 없음
```

### 주의 사항
- `/analytics/...` URL 공간을 (firm)과 (market) 두 route group이 공유한다 (`(firm)/analytics/overview` vs `(market)/analytics/discovery`). 경로가 충돌하지 않으므로 Next.js가 정상 처리한다.
- `analytics/page.tsx`(index redirect)는 route group 밖에 그대로 둔다 — group chrome이 필요 없는 단순 redirect라서.
- `/admin` index 페이지는 현재 존재하지 않으므로 `(admin)/admin/page.tsx`에서 `/admin/users`로 redirect 추가 (top-nav에서 "관리" 라벨 클릭 시 동작 보장).

## 5. 상세 페이지 처리

| 상세 페이지 | chrome 규칙 |
|---|---|
| `/screenplays/[id]`, `/screenplays/new` | 그룹 layout 유지 (제작 헤더 + SubNav). 콘텐츠 상단에 `← 台本一覧` 백 링크 + 페이지 H2. |
| `/admin/registry/[skillSlug]` | 그룹 layout 유지. 콘텐츠 상단에 `← レジストリ` 백 링크 + 페이지 H2. |
| `/analytics/discovery/session/[sessionId]`, `/analytics/discovery/{home,history,insights,live}` | 그룹 layout 유지 (sub-nav가 발견 내 sub-탭으로 활성). |
| `/analytics/strategy/expansion/[strategyId]`, `/analytics/strategy/live/[resultId]` | 그룹 layout 유지. 콘텐츠 상단에 백 링크. |
| `/products/[id]` (리서치 리포트, 13섹션) | **(document) layout** 사용. Navbar + breadcrumb만. 그룹 헤더/SubNav 없음. 리포트 자체 길이가 길어 chrome이 부담. |

백 링크는 별도 컴포넌트로 만들지 않고 페이지 상단에 inline `<Link>`로 두는 것으로 시작 (drive-by abstraction 회피). 만약 5+ 페이지가 동일 패턴을 쓰게 되면 그때 `<BackLink>` 컴포넌트로 추출.

## 6. i18n 키 추가

`messages/ja.json` / `messages/ko.json` 둘 다에 추가:

```json
{
  "nav": {
    "groups": {
      "firm": "自社",      // 既存
      "market": "市場",    // 既存
      "produce": "制作",   // 既存
      "admin": "管理"      // 既存
    },
    "groupHeader": {
      "firm": { "title": "自社データ", "subtitle": "売上・商品・ギャラリー" },
      "market": { "title": "市場リサーチ", "subtitle": "番組カレンダー・新規発掘・MD戦略" },
      "produce": { "title": "制作", "subtitle": "テレビショッピング台本・新規リサーチ" },
      "admin": { "title": "管理", "subtitle": "ユーザー・履歴クロール・スキルレジストリ" }
    }
  }
}
```

현재 (firm)/(market) layout이 raw 일본어 문자열을 하드코딩 중인데, 이번 통합에서 i18n key로 전환.

## 7. 마이그레이션 순서

각 단계는 독립적으로 빌드/플레이가능. 단계별 PR로 잘라도 좋다.

1. **Generic components 추가**: `components/nav/PageHeader.tsx`, `components/nav/GroupSubNav.tsx`. 기존 SubNav 3종은 아직 유지.
2. **i18n 키 추가**: `nav.groupHeader.*` 4개.
3. **(firm), (market) layout 리팩토**: `PageHeader` + `GroupSubNav(...)` 호출로 전환. 기존 SubNav 컴포넌트 참조 제거.
4. **(produce) layout 신규 + 페이지 이동**: `app/[locale]/(produce)/layout.tsx`, `screenplays`, `research` 이동. 각 페이지의 `ProduceSubNav` 수동 import 및 자체 header 코드 삭제.
5. **(admin) layout 신규 + 페이지 이동**: `app/[locale]/(admin)/admin/layout.tsx`, `users/`, `historical-crawl/`, `registry/` (하위 `[skillSlug]/page.tsx` 포함) 이동. 페이지의 자체 `<h1>` 삭제. `(admin)/admin/page.tsx`에서 `/admin/users`로 redirect 추가.
6. **strays 이동**: `gallery/page.tsx` → `(firm)/gallery/`, `broadcasts/{page,loading}.tsx` → `(market)/broadcasts/`. 수동 SubNav import 삭제. broadcasts 페이지 상단의 자체 헤더 정리.
7. **(document) layout + /products/[id] 이동**: `app/[locale]/(document)/products/[id]/page.tsx`. breadcrumb slot pattern 도입.
8. **구 SubNav 삭제**: `components/nav/{Firm,Market,Produce}SubNav.tsx` 삭제. 잔존 import 없는지 grep 확인.
9. **회귀 확인**: 12+ 페이지 클릭 테스트, 모바일 sheet 동작, 로그인/로그아웃 분기, viewer 권한(자사 그룹만 보이는) 분기.

## 8. 비-범위 (Out of scope)

- **NAV_GROUPS 변경 없음** (`lib/nav/groups.ts`). 그룹·멤버·visibility 규칙은 그대로.
- **Navbar 자체 재설계 없음**. 드롭다운/모바일 sheet는 그대로 (별도 dropdown hover bug fix는 이번 PR과 무관하게 별도 진행).
- **새 페이지 추가 없음**. 기존 페이지의 chrome만 통일.
- **시각 디자인 변경 없음**. 기존 SubNav의 styles(둥근 모서리, blue active, shadow)는 그대로 유지.
- **권한/RLS 변경 없음**.

## 9. 성공 기준

- 4개 group route 모두에서 동일한 chrome (group header + SubNav)가 렌더된다.
- `FirmSubNav`, `MarketSubNav`, `ProduceSubNav`가 코드베이스에서 완전히 제거된다.
- 모든 기존 URL이 200 또는 동일한 redirect 결과를 반환한다 (`/analytics/overview`, `/broadcasts`, `/gallery`, `/screenplays`, `/research`, `/admin/users`, `/admin/historical-crawl`, `/admin/registry`, `/products/[id]` 등 12+ 경로).
- 관리 그룹 내에서 ユーザー ↔ 履歴クロール ↔ レジストリ 이동을 sub-nav 탭 한 번으로 할 수 있다.
- `npx tsc --noEmit`가 새 에러 없이 통과한다.
- 모바일 사이즈에서 그룹 헤더가 sub-nav를 가리지 않고 wrap 처리된다.
