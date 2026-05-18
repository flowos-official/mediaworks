# Unified Page Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 12+ page chrome 패턴 4가지(group-layout, manual import, no chrome, stray)를 단일 group-layout 패턴으로 통일. SubNav 컴포넌트 3종 → 1종 generic으로 통합. URL은 모두 그대로 유지.

**Architecture:** Next.js App Router의 route group `(name)`을 [locale] 레벨로 끌어올려 4그룹(`(firm)/(market)/(produce)/(admin)`) + 단일문서용 `(document)` route group을 둔다. 각 그룹 layout이 `<PageHeader>` + `<GroupSubNav>`를 렌더하고 페이지는 콘텐츠만 담당. route group은 URL에 영향을 주지 않으므로 기존 모든 URL이 그대로 동작.

**Tech Stack:** Next.js 16 App Router, next-intl, React 19, Tailwind CSS 4, Lucide icons, Supabase (auth/RLS, 변경 없음).

**Spec:** `docs/superpowers/specs/2026-05-18-unified-page-chrome-design.md`

**Verification model:** 프로젝트에 테스트 프레임워크가 없음 (CLAUDE.md). 각 task는 (1) `npx tsc --noEmit` 통과 + (2) `npm run dev`로 해당 URL 직접 열어 chrome 렌더 확인 + (3) commit으로 검증.

---

## File Structure Overview

**Create (new generic + new layouts):**
- `components/nav/PageHeader.tsx` — 아이콘+제목+서브타이틀+action slot
- `components/nav/GroupSubNav.tsx` — `groupKey` prop으로 NAV_GROUPS 멤버 렌더
- `lib/analytics/firm-filter-context.tsx` — 기존 layout 내 context를 분리
- `app/[locale]/(firm)/layout.tsx`
- `app/[locale]/(market)/layout.tsx`
- `app/[locale]/(produce)/layout.tsx`
- `app/[locale]/(admin)/admin/layout.tsx`
- `app/[locale]/(admin)/admin/page.tsx` — /admin/users로 redirect
- `app/[locale]/(document)/layout.tsx`

**Move (URL 불변):**
- `analytics/(firm)/overview/page.tsx` → `(firm)/analytics/overview/page.tsx`
- `analytics/(firm)/products/page.tsx` → `(firm)/analytics/products/page.tsx`
- `analytics/(market)/discovery/**` → `(market)/analytics/discovery/**`
- `analytics/(market)/strategy/**` → `(market)/analytics/strategy/**`
- `screenplays/**` → `(produce)/screenplays/**`
- `research/page.tsx` → `(produce)/research/page.tsx`
- `admin/**` → `(admin)/admin/**`
- `gallery/page.tsx` → `(firm)/gallery/page.tsx`
- `broadcasts/{page,loading}.tsx` → `(market)/broadcasts/`
- `products/[id]/page.tsx` → `(document)/products/[id]/page.tsx`

**Modify (in-place):**
- `messages/ja.json` — i18n 키 추가
- `messages/ko.json` — i18n 키 추가
- `app/[locale]/gallery/page.tsx` (이동 후) — `FirmSubNav` import + 인라인 SubNav 2곳 삭제
- `app/[locale]/broadcasts/page.tsx` (이동 후) — `MarketSubNav` import + 인라인 SubNav 삭제
- `app/[locale]/screenplays/page.tsx` (이동 후) — `ProduceSubNav` import + 자체 badge/H1/subtitle 헤더 정리
- `app/[locale]/research/page.tsx` (이동 후) — `ProduceSubNav` import + 자체 badge/H1/subtitle 헤더 정리
- `app/[locale]/admin/users/page.tsx` (이동 후) — 자체 `<h1>{t('title')}</h1>` 제거 (group header가 대체)
- `app/[locale]/admin/historical-crawl/page.tsx` (이동 후) — `<main>` wrapper 제거 (layout이 제공)

**Delete:**
- `components/nav/FirmSubNav.tsx`
- `components/nav/MarketSubNav.tsx`
- `components/nav/ProduceSubNav.tsx`
- `app/[locale]/analytics/(firm)/` (빈 폴더 — 이동 후 자동 제거 또는 수동)
- `app/[locale]/analytics/(market)/` (빈 폴더)

---

## Task 1: Add `<PageHeader>` and `<GroupSubNav>` generic components

**Files:**
- Create: `components/nav/PageHeader.tsx`
- Create: `components/nav/GroupSubNav.tsx`

기존 SubNav 3종은 아직 보존 (다음 task들이 의존). 이 task는 새 컴포넌트를 추가만 한다.

- [ ] **Step 1: Write `components/nav/PageHeader.tsx`**

```tsx
// components/nav/PageHeader.tsx
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export default function PageHeader({ icon: Icon, title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Icon size={20} className="text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        </div>
        {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Write `components/nav/GroupSubNav.tsx`**

```tsx
// components/nav/GroupSubNav.tsx
'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS, findActiveMember, type GroupKey } from '@/lib/nav/groups';

interface GroupSubNavProps {
  groupKey: GroupKey;
}

export default function GroupSubNav({ groupKey }: GroupSubNavProps) {
  const { locale } = useParams<{ locale: string }>();
  const pathname = usePathname();
  const t = useTranslations();
  const group = NAV_GROUPS.find((g) => g.key === groupKey);
  if (!group) return null;
  const activeHref = findActiveMember(group, pathname)?.href ?? null;

  return (
    <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm w-fit">
      {group.members.map((m) => {
        const isActive = activeHref === m.href;
        return (
          <Link
            key={m.href}
            href={localePath(locale, m.href)}
            prefetch
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
              isActive ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {t(m.labelKey)}
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: 새 에러 없음 (기존의 `.next/types/validator.ts`, `pg` 모듈 관련 에러는 무시 — 빌드 캐시/스크립트 종속).

- [ ] **Step 4: Commit**

```bash
git add components/nav/PageHeader.tsx components/nav/GroupSubNav.tsx
git commit -m "feat(nav): add generic PageHeader and GroupSubNav components"
```

---

## Task 2: Add `nav.groupHeader.*` i18n keys

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`

기존 (firm)/(market) layout이 일본어 raw 문자열 하드코딩 중 — 이제 i18n 키로 전환할 자리를 만든다.

- [ ] **Step 1: Locate existing `nav` block in `messages/ja.json`**

Run: `grep -n '"nav":' messages/ja.json` 으로 `"nav": {` 블록 시작 줄 확인. 안에 `"groups": { "firm": "自社", "market": "市場", "produce": "制作", "admin": "管理" }`가 이미 있다.

- [ ] **Step 2: Add `groupHeader` block inside `nav` in `messages/ja.json`**

`nav.groups` 블록 다음에 다음을 추가:

```json
    "groupHeader": {
      "firm": { "title": "自社データ", "subtitle": "売上・商品・ギャラリー" },
      "market": { "title": "市場リサーチ", "subtitle": "番組カレンダー・新規発掘・MD戦略" },
      "produce": { "title": "制作", "subtitle": "テレビショッピング台本・新規リサーチ" },
      "admin": { "title": "管理", "subtitle": "ユーザー・履歴クロール・スキルレジストリ" }
    }
```

- [ ] **Step 3: Add the same `groupHeader` block in `messages/ko.json` with Korean translations**

```json
    "groupHeader": {
      "firm": { "title": "자사 데이터", "subtitle": "매출 · 상품 · 갤러리" },
      "market": { "title": "시장 리서치", "subtitle": "방송 캘린더 · 신규 발굴 · MD 전략" },
      "produce": { "title": "제작", "subtitle": "TV쇼핑 대본 · 신규 리서치" },
      "admin": { "title": "관리", "subtitle": "사용자 · 이력 크롤 · 스킬 레지스트리" }
    }
```

- [ ] **Step 4: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('messages/ja.json','utf8')); JSON.parse(require('fs').readFileSync('messages/ko.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add messages/ja.json messages/ko.json
git commit -m "i18n(nav): add nav.groupHeader keys for 4 groups"
```

---

## Task 3: Extract firm filter context to lib + lift (firm) layout

**Files:**
- Create: `lib/analytics/firm-filter-context.tsx`
- Create: `app/[locale]/(firm)/layout.tsx`
- Move: `app/[locale]/analytics/(firm)/overview/page.tsx` → `app/[locale]/(firm)/analytics/overview/page.tsx` (and update import)
- Move: `app/[locale]/analytics/(firm)/products/page.tsx` → `app/[locale]/(firm)/analytics/products/page.tsx` (and update import)
- Delete: `app/[locale]/analytics/(firm)/layout.tsx` (after move)
- Delete: `app/[locale]/analytics/(firm)/` (empty dir after move)

기존 layout은 `AnalyticsFilterContext`와 `useAnalyticsFilter`를 내부에 정의한다. 페이지가 `'../layout'`을 import해서 결합되어 있어 layout 위치 변경 시 깨진다. 먼저 context를 stable 위치(`lib/`)로 분리해 이 결합을 끊는다.

- [ ] **Step 1: Write `lib/analytics/firm-filter-context.tsx`**

```tsx
// lib/analytics/firm-filter-context.tsx
'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

export type Period = 'weekly' | 'monthly';

export interface FirmFilterContextValue {
  selectedYears: number[];
  setSelectedYears: (y: number[]) => void;
  period: Period;
  setPeriod: (p: Period) => void;
}

const Ctx = createContext<FirmFilterContextValue | null>(null);

export function FirmFilterProvider({ children }: { children: ReactNode }) {
  const [selectedYears, setSelectedYears] = useState<number[]>([2025, 2026]);
  const [period, setPeriod] = useState<Period>('weekly');
  return (
    <Ctx.Provider value={{ selectedYears, setSelectedYears, period, setPeriod }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAnalyticsFilter(): FirmFilterContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAnalyticsFilter must be used inside FirmFilterProvider');
  return ctx;
}
```

- [ ] **Step 2: Create `app/[locale]/(firm)/layout.tsx`**

```tsx
// app/[locale]/(firm)/layout.tsx
'use client';

import type { ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';
import DateRangeFilter from '@/components/analytics/DateRangeFilter';
import { FirmFilterProvider, useAnalyticsFilter } from '@/lib/analytics/firm-filter-context';

function FilterAction() {
  const { selectedYears, setSelectedYears, period, setPeriod } = useAnalyticsFilter();
  return (
    <DateRangeFilter
      years={[2025, 2026]}
      selectedYears={selectedYears}
      period={period}
      onYearsChange={setSelectedYears}
      onPeriodChange={setPeriod}
    />
  );
}

export default function FirmLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('nav.groupHeader.firm');
  return (
    <FirmFilterProvider>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <PageHeader
          icon={BarChart3}
          title={t('title')}
          subtitle={t('subtitle')}
          action={<FilterAction />}
        />
        <div className="space-y-6">
          <GroupSubNav groupKey="firm" />
          {children}
        </div>
      </main>
    </FirmFilterProvider>
  );
}
```

- [ ] **Step 3: Move `analytics/(firm)/overview/page.tsx`**

Run:
```bash
mkdir -p "app/[locale]/(firm)/analytics/overview"
git mv "app/[locale]/analytics/(firm)/overview/page.tsx" "app/[locale]/(firm)/analytics/overview/page.tsx"
```

Then edit the moved file: change line 10 from
```ts
import { useAnalyticsFilter } from '../layout';
```
to
```ts
import { useAnalyticsFilter } from '@/lib/analytics/firm-filter-context';
```

- [ ] **Step 4: Move `analytics/(firm)/products/page.tsx`**

Run:
```bash
mkdir -p "app/[locale]/(firm)/analytics/products"
git mv "app/[locale]/analytics/(firm)/products/page.tsx" "app/[locale]/(firm)/analytics/products/page.tsx"
```

Then edit the moved file: change line 8 from
```ts
import { useAnalyticsFilter } from '../layout';
```
to
```ts
import { useAnalyticsFilter } from '@/lib/analytics/firm-filter-context';
```

- [ ] **Step 5: Delete old `analytics/(firm)/layout.tsx` and empty folder**

```bash
git rm "app/[locale]/analytics/(firm)/layout.tsx"
rmdir "app/[locale]/analytics/(firm)/overview" "app/[locale]/analytics/(firm)/products" "app/[locale]/analytics/(firm)" 2>/dev/null || true
```

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`
Expected: 새 에러 없음.

- [ ] **Step 7: Manual visual check**

Run: `npm run dev`
Open in browser:
- `http://localhost:3000/ja/analytics/overview` — 헤더 "自社データ" + 서브타이틀 + 우측 DateRange 필터 + 아래 SubNav(매출/상품/이미지) 렌더 확인.
- `http://localhost:3000/ja/analytics/products` — 동일 chrome + 상품 분석 콘텐츠.
- 두 페이지 사이 sub-nav 탭 이동 확인.

확인 끝나면 dev 서버 종료.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(firm): lift (firm) route group to [locale], extract filter context"
```

---

## Task 4: Lift (market) layout

**Files:**
- Create: `app/[locale]/(market)/layout.tsx`
- Move: `analytics/(market)/discovery/{history,home,insights,live,page,session/[sessionId]/page}.tsx` → `(market)/analytics/discovery/...`
- Move: `analytics/(market)/strategy/{expansion/page,expansion/[strategyId]/page,live/page,live/[resultId]/page,page}.tsx` → `(market)/analytics/strategy/...`
- Delete: `app/[locale]/analytics/(market)/layout.tsx` and emptied subdirs

- [ ] **Step 1: Create `app/[locale]/(market)/layout.tsx`**

```tsx
// app/[locale]/(market)/layout.tsx
import type { ReactNode } from 'react';
import { Globe2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';

export default async function MarketLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('nav.groupHeader.market');
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <PageHeader icon={Globe2} title={t('title')} subtitle={t('subtitle')} />
      <div className="space-y-6">
        <GroupSubNav groupKey="market" />
        {children}
      </div>
    </main>
  );
}
```

(서버 컴포넌트로 작성 — context가 필요 없으므로 `'use client'` 불필요. `GroupSubNav`는 client 컴포넌트이지만 children-as-react-tree 패턴은 자동 처리됨.)

- [ ] **Step 2: Move discovery routes**

Run each `git mv` (mkdir -p로 대상 경로 보장):

```bash
mkdir -p "app/[locale]/(market)/analytics/discovery/history"
mkdir -p "app/[locale]/(market)/analytics/discovery/home"
mkdir -p "app/[locale]/(market)/analytics/discovery/insights"
mkdir -p "app/[locale]/(market)/analytics/discovery/live"
mkdir -p "app/[locale]/(market)/analytics/discovery/session/[sessionId]"
git mv "app/[locale]/analytics/(market)/discovery/page.tsx"           "app/[locale]/(market)/analytics/discovery/page.tsx"
git mv "app/[locale]/analytics/(market)/discovery/history/page.tsx"   "app/[locale]/(market)/analytics/discovery/history/page.tsx"
git mv "app/[locale]/analytics/(market)/discovery/home/page.tsx"      "app/[locale]/(market)/analytics/discovery/home/page.tsx"
git mv "app/[locale]/analytics/(market)/discovery/insights/page.tsx"  "app/[locale]/(market)/analytics/discovery/insights/page.tsx"
git mv "app/[locale]/analytics/(market)/discovery/live/page.tsx"      "app/[locale]/(market)/analytics/discovery/live/page.tsx"
git mv "app/[locale]/analytics/(market)/discovery/session/[sessionId]/page.tsx" "app/[locale]/(market)/analytics/discovery/session/[sessionId]/page.tsx"
```

- [ ] **Step 3: Move strategy routes**

```bash
mkdir -p "app/[locale]/(market)/analytics/strategy/expansion/[strategyId]"
mkdir -p "app/[locale]/(market)/analytics/strategy/live/[resultId]"
git mv "app/[locale]/analytics/(market)/strategy/page.tsx"                     "app/[locale]/(market)/analytics/strategy/page.tsx"
git mv "app/[locale]/analytics/(market)/strategy/expansion/page.tsx"           "app/[locale]/(market)/analytics/strategy/expansion/page.tsx"
git mv "app/[locale]/analytics/(market)/strategy/expansion/[strategyId]/page.tsx" "app/[locale]/(market)/analytics/strategy/expansion/[strategyId]/page.tsx"
git mv "app/[locale]/analytics/(market)/strategy/live/page.tsx"                "app/[locale]/(market)/analytics/strategy/live/page.tsx"
git mv "app/[locale]/analytics/(market)/strategy/live/[resultId]/page.tsx"     "app/[locale]/(market)/analytics/strategy/live/[resultId]/page.tsx"
```

- [ ] **Step 4: Delete old layout and empty parent**

```bash
git rm "app/[locale]/analytics/(market)/layout.tsx"
# Remove leftover empty directories (best-effort; ignore failures)
find "app/[locale]/analytics/(market)" -type d -empty -delete 2>/dev/null || true
```

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Manual visual check**

Run: `npm run dev`. Verify:
- `/ja/analytics/discovery` — "市場リサーチ" 헤더 + SubNav(번組/발굴/전략).
- `/ja/analytics/discovery/home`, `/insights`, `/live`, `/history` — 동일 chrome (SubNav의 "발굴" 활성).
- `/ja/analytics/strategy` → expansion 또는 live로 리다이렉트되는지(기존 동작 보존).
- `/ja/analytics/strategy/expansion`, `/strategy/live` — 동일 chrome.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(market): lift (market) route group to [locale]"
```

---

## Task 5: Create (produce) layout + move screenplays and research

**Files:**
- Create: `app/[locale]/(produce)/layout.tsx`
- Move: `screenplays/{page,new/page,[id]/page}.tsx` → `(produce)/screenplays/...`
- Move: `research/page.tsx` → `(produce)/research/page.tsx`
- Modify (post-move): `(produce)/screenplays/page.tsx` — `ProduceSubNav` import + 자체 헤더 정리
- Modify (post-move): `(produce)/research/page.tsx` — `ProduceSubNav` import + 자체 헤더 정리

- [ ] **Step 1: Create `app/[locale]/(produce)/layout.tsx`**

```tsx
// app/[locale]/(produce)/layout.tsx
import type { ReactNode } from 'react';
import { Clapperboard } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';

export default async function ProduceLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('nav.groupHeader.produce');
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <PageHeader icon={Clapperboard} title={t('title')} subtitle={t('subtitle')} />
      <div className="space-y-6">
        <GroupSubNav groupKey="produce" />
        {children}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Move screenplay routes**

```bash
mkdir -p "app/[locale]/(produce)/screenplays/new"
mkdir -p "app/[locale]/(produce)/screenplays/[id]"
git mv "app/[locale]/screenplays/page.tsx"      "app/[locale]/(produce)/screenplays/page.tsx"
git mv "app/[locale]/screenplays/new/page.tsx"  "app/[locale]/(produce)/screenplays/new/page.tsx"
git mv "app/[locale]/screenplays/[id]/page.tsx" "app/[locale]/(produce)/screenplays/[id]/page.tsx"
```

- [ ] **Step 3: Edit `(produce)/screenplays/page.tsx` — remove ProduceSubNav import and inline header**

기존 코드는 자체 badge + H1 + subtitle을 페이지 내부에 가지고 있다. group layout이 PageHeader를 제공하므로 페이지의 자체 헤더는 페이지-스코프 정보만 남기고 정리. CTA 버튼(`新しい台本を作成`)은 페이지에 그대로 유지.

Replace lines 1-5 (imports) with:
```tsx
import Link from "next/link";
import { Plus } from "lucide-react";
import { ScreenplayList } from "@/components/screenplay/ScreenplayList";
import { localePath } from "@/lib/i18n/locale-path";
```
(`Clapperboard`와 `ProduceSubNav` import 제거.)

Replace the JSX body (lines 22-48 approximately) with:
```tsx
  return (
    <>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">台本一覧</h2>
          <p className="text-sm text-gray-500 mt-1 max-w-xl">
            商品を選んで、生放送さながらのテレビショッピング台本を作成します。フィードバックを送ると何度でも改稿できます。
          </p>
        </div>
        <Link
          href={localePath(locale, "/screenplays/new")}
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors shrink-0"
        >
          <Plus size={16} />
          新しい台本を作成
        </Link>
      </header>
      <ScreenplayList rows={rows} locale={locale} />
    </>
  );
```

(외부 `<main>` wrapper와 `<ProduceSubNav />`, `mb-6` 컨테이너 제거 — layout이 모두 제공. `<></>` 프래그먼트로 변환.)

- [ ] **Step 4: Move research route**

```bash
mkdir -p "app/[locale]/(produce)/research"
git mv "app/[locale]/research/page.tsx" "app/[locale]/(produce)/research/page.tsx"
```

- [ ] **Step 5: Edit `(produce)/research/page.tsx` — remove ProduceSubNav and centered banner**

Replace lines 1-9 (imports) with:
```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import FileUpload from '@/components/FileUpload';
import ProductList from '@/components/ProductList';
```
(`Sparkles`와 `ProduceSubNav` import 제거.)

Replace the JSX body with:
```tsx
  return (
    <>
      <div className="max-w-2xl mx-auto">
        <FileUpload onUploadComplete={handleUploadComplete} />
      </div>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-6">{t('recentProducts')}</h2>
        <ProductList refreshTrigger={refreshTrigger} />
      </section>
    </>
  );
```

(외부 `<main>` wrapper, `<ProduceSubNav />`, 중앙 정렬된 hero(`text-center`, badge, H1, description)를 모두 제거. group header가 페이지 컨텍스트 제공.)

- [ ] **Step 6: Type check + visual check**

Run: `npx tsc --noEmit`
Run: `npm run dev`. Verify:
- `/ja/screenplays` — "制作" 헤더 + SubNav(台本/리서치) + 台本一覧 콘텐츠 + CTA 버튼.
- `/ja/screenplays/new`, `/ja/screenplays/<id>` — 동일 chrome.
- `/ja/research` — "制作" 헤더 + SubNav + 파일 업로드 + 최근 상품 리스트.
- SubNav 두 탭 사이 이동 확인.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(produce): add (produce) layout, move screenplays/research"
```

---

## Task 6: Create (admin) layout + move admin pages + add admin index redirect

**Files:**
- Create: `app/[locale]/(admin)/admin/layout.tsx`
- Create: `app/[locale]/(admin)/admin/page.tsx` (redirect)
- Move: `admin/{users,historical-crawl,registry,registry/[skillSlug]}/page.tsx` (+ `users/UsersTable.tsx`)
- Modify: `admin/users/page.tsx` (post-move) — 자체 `<h1>` 제거
- Modify: `admin/historical-crawl/page.tsx` (post-move) — `<main>` wrapper 제거

- [ ] **Step 1: Create `app/[locale]/(admin)/admin/layout.tsx`**

```tsx
// app/[locale]/(admin)/admin/layout.tsx
import type { ReactNode } from 'react';
import { Settings } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('nav.groupHeader.admin');
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <PageHeader icon={Settings} title={t('title')} subtitle={t('subtitle')} />
      <div className="space-y-6">
        <GroupSubNav groupKey="admin" />
        {children}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Create `app/[locale]/(admin)/admin/page.tsx` (index redirect)**

```tsx
// app/[locale]/(admin)/admin/page.tsx
import { redirect } from 'next/navigation';
import { localePath } from '@/lib/i18n/locale-path';

export default async function AdminIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(localePath(locale, '/admin/users'));
}
```

(Navbar의 "관리" 드롭다운 라벨 클릭 시 `/admin`으로 가는데 현재는 페이지가 없다 → 404 회피.)

- [ ] **Step 3: Move admin page files**

```bash
mkdir -p "app/[locale]/(admin)/admin/users"
mkdir -p "app/[locale]/(admin)/admin/historical-crawl"
mkdir -p "app/[locale]/(admin)/admin/registry/[skillSlug]"
git mv "app/[locale]/admin/users/page.tsx"             "app/[locale]/(admin)/admin/users/page.tsx"
git mv "app/[locale]/admin/users/UsersTable.tsx"       "app/[locale]/(admin)/admin/users/UsersTable.tsx"
git mv "app/[locale]/admin/historical-crawl/page.tsx"  "app/[locale]/(admin)/admin/historical-crawl/page.tsx"
git mv "app/[locale]/admin/registry/page.tsx"          "app/[locale]/(admin)/admin/registry/page.tsx"
git mv "app/[locale]/admin/registry/[skillSlug]/page.tsx" "app/[locale]/(admin)/admin/registry/[skillSlug]/page.tsx"
find "app/[locale]/admin" -type d -empty -delete 2>/dev/null || true
```

- [ ] **Step 4: Edit `(admin)/admin/users/page.tsx` — remove inline H1 and adjust wrapper**

기존:
```tsx
return (
  <div className="max-w-5xl mx-auto p-6 space-y-4">
    <h1 className="text-2xl font-bold">{t('title')}</h1>
    <UsersTable initial={users ?? []} currentUserId={user.id} />
  </div>
);
```

으로 변경:
```tsx
return (
  <UsersTable initial={users ?? []} currentUserId={user.id} />
);
```

이유: layout이 PageHeader("管理")와 max-w-7xl wrapper, py-8 padding 모두 제공. 페이지의 자체 `max-w-5xl mx-auto p-6` wrapper와 `<h1>{t('title')}</h1>` 중복 제거. `t` 변수도 더 이상 안 쓰면 import 제거.

`const t = await getTranslations('admin.users');` 라인과 `import { getTranslations } from 'next-intl/server';` 제거 (사용 안 함).

- [ ] **Step 5: Edit `(admin)/admin/historical-crawl/page.tsx` — remove `<main>` wrapper**

기존:
```tsx
return (
  <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <HistoricalCrawlDashboard ... />
  </main>
);
```

으로 변경:
```tsx
return (
  <HistoricalCrawlDashboard
    initialRuns={
      (runs ?? []) as Parameters<
        typeof HistoricalCrawlDashboard
      >[0]["initialRuns"]
    }
    baseline={baseline}
  />
);
```

이유: layout이 `<main>` + max-w + padding 제공. 중첩된 `<main>`은 시맨틱 오류.

- [ ] **Step 6: Inspect `(admin)/admin/registry/page.tsx` and `[skillSlug]/page.tsx`**

해당 파일들의 외부 wrapper를 확인. `<main>` 또는 `<div className="max-w-..."` 형태로 페이지 자체 컨테이너가 있다면 제거 (layout이 제공). 자체 `<h1>`는 유지 (페이지 단위 제목이므로). registry 두 파일을 열어 패턴 확인 후 동일 정리.

Read: `cat "app/[locale]/(admin)/admin/registry/page.tsx" | head -100` 으로 확인.

- [ ] **Step 7: Type check + visual check**

Run: `npx tsc --noEmit`
Run: `npm run dev`. Verify (admin 계정으로 로그인):
- `/ja/admin` — `/ja/admin/users`로 redirect.
- `/ja/admin/users` — "管理" 헤더 + SubNav(ユーザー/履歴クロール/レジストリ) + UsersTable.
- `/ja/admin/historical-crawl` — 동일 chrome + 대시보드.
- `/ja/admin/registry` — 동일 chrome + 레지스트리 리스트.
- `/ja/admin/registry/<slug>` — 동일 chrome + 디테일.
- SubNav 세 탭 이동 확인.
- Member 계정으로 로그인 시 `/admin/*` 접근 불가 확인 (기존 RLS/redirect 그대로 동작해야 함).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(admin): add (admin) layout with SubNav, move admin pages"
```

---

## Task 7: Move /gallery into (firm)/gallery

**Files:**
- Move: `app/[locale]/gallery/page.tsx` → `app/[locale]/(firm)/gallery/page.tsx`
- Modify (post-move): drop `FirmSubNav` import + 2개 인라인 렌더

- [ ] **Step 1: Move file**

```bash
mkdir -p "app/[locale]/(firm)/gallery"
git mv "app/[locale]/gallery/page.tsx" "app/[locale]/(firm)/gallery/page.tsx"
rmdir "app/[locale]/gallery" 2>/dev/null || true
```

- [ ] **Step 2: Remove FirmSubNav import and inline renders**

Edit `app/[locale]/(firm)/gallery/page.tsx`:

a) Remove import line:
```tsx
import FirmSubNav from '@/components/nav/FirmSubNav';
```

b) Remove both `<FirmSubNav />` renders (line ~123 desktop, line ~243 mobile or fallback). Confirm: `grep -n FirmSubNav "app/[locale]/(firm)/gallery/page.tsx"` 결과가 0줄이어야 한다.

c) 페이지 최외곽 wrapper가 `<main className="max-w-7xl ...">` 또는 자체 컨테이너라면 제거 — layout이 이미 제공. 페이지는 콘텐츠 fragment만 반환.

- [ ] **Step 3: Type check + visual check**

Run: `npx tsc --noEmit`
Run: `npm run dev`. Verify:
- `/ja/gallery` — "自社データ" 헤더 + DateRange filter + SubNav(매출/상품/이미지) + 갤러리 콘텐츠. SubNav의 "상품 이미지"가 active.
- DateRange filter는 firm layout에서 렌더되지만 gallery 페이지는 사용하지 않음 — 화면에 노출되는 것은 의도된 동작 (firm group의 공통 헤더 액션).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(firm): move /gallery into (firm) route group"
```

---

## Task 8: Move /broadcasts into (market)/broadcasts

**Files:**
- Move: `app/[locale]/broadcasts/{page,loading}.tsx` → `app/[locale]/(market)/broadcasts/`
- Modify (post-move): drop `MarketSubNav` import + inline render + 페이지 자체 헤더 정리

- [ ] **Step 1: Move files**

```bash
mkdir -p "app/[locale]/(market)/broadcasts"
git mv "app/[locale]/broadcasts/page.tsx"    "app/[locale]/(market)/broadcasts/page.tsx"
git mv "app/[locale]/broadcasts/loading.tsx" "app/[locale]/(market)/broadcasts/loading.tsx"
rmdir "app/[locale]/broadcasts" 2>/dev/null || true
```

- [ ] **Step 2: Remove MarketSubNav and clean up page header**

Edit `app/[locale]/(market)/broadcasts/page.tsx`:

a) Remove line:
```tsx
import MarketSubNav from "@/components/nav/MarketSubNav";
```

b) Remove `<MarketSubNav />` render (line ~129) and the wrapper element holding it if redundant. `grep -n MarketSubNav` 결과가 0줄이어야 한다.

c) Read the file's JSX top section (Search around the "ArrowLeft" import or page title block). If there's an inline `<h1>` with "番組カレンダー" or similar group-level title, remove it (group layout이 제공). 페이지 단위의 sub-title (예: 월 선택, 검색)은 유지.

d) 최외곽 wrapper (`<main>` / `<div className="max-w-7xl ...">`)가 있다면 제거 (layout이 제공). 페이지는 콘텐츠 fragment만 반환.

- [ ] **Step 3: Type check + visual check**

Run: `npx tsc --noEmit`
Run: `npm run dev`. Verify:
- `/ja/broadcasts` — "市場リサーチ" 헤더 + SubNav(번組/발굴/전략) — "번組"가 active. + 캘린더 + UnifiedDayDetailPanel + HistoricalBroadcasts 모두 정상.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(market): move /broadcasts into (market) route group"
```

---

## Task 9: Create (document) layout + move /products/[id]

**Files:**
- Create: `app/[locale]/(document)/layout.tsx`
- Move: `app/[locale]/products/[id]/page.tsx` → `app/[locale]/(document)/products/[id]/page.tsx`

리서치 리포트(13섹션)는 그룹 chrome 없이 Navbar + 페이지 자체 헤더로 표시.

- [ ] **Step 1: Create `app/[locale]/(document)/layout.tsx`**

```tsx
// app/[locale]/(document)/layout.tsx
import type { ReactNode } from 'react';

export default function DocumentLayout({ children }: { children: ReactNode }) {
  return <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">{children}</main>;
}
```

최소 chrome: max-width wrapper + padding. 페이지가 자체 breadcrumb + 헤더 + 13섹션 콘텐츠를 모두 책임. 별도 컴포넌트 추출은 5+ 페이지가 같은 패턴 쓸 때까지 보류 (YAGNI).

- [ ] **Step 2: Move file**

```bash
mkdir -p "app/[locale]/(document)/products/[id]"
git mv "app/[locale]/products/[id]/page.tsx" "app/[locale]/(document)/products/[id]/page.tsx"
rmdir "app/[locale]/products/[id]" "app/[locale]/products" 2>/dev/null || true
```

- [ ] **Step 3: Inspect moved page**

Read: `head -50 "app/[locale]/(document)/products/[id]/page.tsx"`
페이지가 이미 자체 `<main>` wrapper를 갖고 있다면 제거 (layout 제공). 페이지 콘텐츠 fragment만 반환.

- [ ] **Step 4: Type check + visual check**

Run: `npx tsc --noEmit`
Run: `npm run dev`. Verify:
- `/ja/products/<some-existing-id>` — Navbar + 페이지 자체 헤더/breadcrumb + 13섹션 리포트 + PDF download 버튼.
- 그룹 헤더/SubNav는 의도적으로 없음.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(document): add (document) layout, move /products/[id]"
```

---

## Task 10: Delete obsolete SubNav components and empty folders

**Files:**
- Delete: `components/nav/FirmSubNav.tsx`
- Delete: `components/nav/MarketSubNav.tsx`
- Delete: `components/nav/ProduceSubNav.tsx`
- Delete: any remaining empty `app/[locale]/analytics/(firm)/`, `app/[locale]/analytics/(market)/` directories

- [ ] **Step 1: Confirm no remaining imports**

Run: `grep -rn "FirmSubNav\|MarketSubNav\|ProduceSubNav" app components lib`
Expected: 결과 없음. 있다면 해당 파일에서 import + 사용을 제거하고 commit (이전 task에서 빠뜨린 것).

- [ ] **Step 2: Delete the three components**

```bash
git rm components/nav/FirmSubNav.tsx components/nav/MarketSubNav.tsx components/nav/ProduceSubNav.tsx
```

- [ ] **Step 3: Clean up empty directories**

```bash
find "app/[locale]/analytics/(firm)" "app/[locale]/analytics/(market)" -type d -empty -delete 2>/dev/null || true
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: 새 에러 없음.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(nav): remove obsolete SubNav components"
```

---

## Task 11: Final route walkthrough

**Files:** none (verification only).

전체 페이지에 대한 chrome 일관성과 권한 분기를 손으로 확인한다.

- [ ] **Step 1: Run dev server**

```bash
npm run dev
```

- [ ] **Step 2: Admin walkthrough**

admin 계정으로 로그인 (`/ja/login`). 다음 12+ URL을 차례로 열어 각 페이지가 (group header + SubNav + 콘텐츠) 또는 (document layout) 패턴인지 확인:

| URL | 기대 그룹 헤더 | 기대 SubNav active |
|---|---|---|
| `/ja/analytics/overview` | 自社データ | 매출 개요 |
| `/ja/analytics/products` | 自社データ | 상품 분석 |
| `/ja/gallery` | 自社データ | 상품 이미지 |
| `/ja/broadcasts` | 市場リサーチ | 番組 |
| `/ja/analytics/discovery` | 市場リサーチ | 신규 발굴 |
| `/ja/analytics/discovery/home` | 市場リサーチ | 신규 발굴 |
| `/ja/analytics/strategy` | 市場リサーチ | 신규 추천 |
| `/ja/screenplays` | 制作 | 台本 |
| `/ja/research` | 制作 | 리서치 |
| `/ja/admin` → redirect to users | — | — |
| `/ja/admin/users` | 管理 | ユーザー |
| `/ja/admin/historical-crawl` | 管理 | 履歴クロール |
| `/ja/admin/registry` | 管理 | レジストリ |
| `/ja/products/<id>` | (document, 그룹 chrome 없음) | — |

- [ ] **Step 3: Member walkthrough**

member 계정으로 로그아웃 후 재로그인. `/ja/admin/*`이 접근 차단되고 `/ja/login` 또는 `/ja`로 리다이렉트되는지 확인 (기존 `requireUser` 동작).

- [ ] **Step 4: Viewer walkthrough**

viewer 계정으로 로그인. Navbar의 "자사" 드롭다운 대신 단일 링크(`/analytics/products`)가 보이고 다른 그룹은 숨겨지는지 확인 (`groupVisibility = 'productsOnly' / 'hidden'`).

- [ ] **Step 5: Korean locale spot-check**

`/ko/analytics/overview` → "자사 데이터" 헤더가 한국어로 렌더되는지 확인.

- [ ] **Step 6: Mobile sheet**

브라우저 가로를 768px 이하로 줄여 모바일 햄버거 메뉴(`MobileNavSheet`)가 모든 그룹+멤버를 그대로 노출하는지 확인. group SubNav는 페이지 안에 있으므로 모바일에서도 표시.

- [ ] **Step 7: Document any remaining issue**

문제 발견 시 별도 task로 잡고 fix → commit. 전부 통과면 plan 완료.

- [ ] **Step 8: Final type check**

Run: `npx tsc --noEmit`
Expected: 새 에러 없음.

- [ ] **Step 9: Sanity grep**

```bash
grep -rn "FirmSubNav\|MarketSubNav\|ProduceSubNav" app components lib
```
Expected: 결과 0줄.

```bash
ls "app/[locale]/analytics/" 2>/dev/null
```
Expected: `page.tsx`만 남음 (redirect; `(firm)`/`(market)` 폴더는 제거됨).

검증 완료 후 별도 commit 불필요.

---

## Self-Review Notes

- Task 3에서 `lib/analytics/firm-filter-context.tsx`로 context를 분리한 것은 spec section 3에서 "위치만 이동"으로만 언급됐는데, 실제 구현 시 layout 위치 변경으로 인한 import 경로 깨짐을 막기 위한 결정. spec scope 안.
- `(admin)/admin/page.tsx` redirect는 spec section 4의 "주의 사항"에 명시됨.
- `(document)` layout은 minimal wrapper로 시작 (spec section 5에서 "별도 컴포넌트로 만들지 않고 inline `<Link>`로 두는 것으로 시작"과 동일한 YAGNI 정신).
- 모바일 sheet는 spec section 8 "비-범위"에 변경 없음 — Task 11에서 회귀 확인만 한다.
