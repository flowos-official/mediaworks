# Nav Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize top-nav into 4 data-source groups (자사/시장/제작/관리) with dropdown UI, split `/analytics` into route groups, and move home upload UI to `/research`.

**Architecture:** Single source of truth at `lib/nav/groups.ts` drives Navbar dropdowns + page-level sub-nav + active matching. `/analytics` splits into `(firm)` / `(market)` Next.js route groups (URL impact = zero). `/` becomes a server-side role-redirect; the existing home page (upload + recent list) moves to `/research` inside the *제작* group.

**Tech Stack:** Next.js App Router (Server Components for Navbar/page redirects, Client Components for dropdown interactivity), next-intl v3, Tailwind CSS 4, Lucide icons, Supabase Auth (`@supabase/ssr`).

**Reference spec:** `docs/superpowers/specs/2026-05-17-nav-restructure-design.md`

**Repo note — no test framework configured.** Verification per task = TypeScript check (`npx tsc --noEmit`) + manual dev-server smoke test (`npm run dev` at `localhost:3000`). Each task ends with a commit. Each Step (numbered below) is an independently shippable PR.

---

## File map

| File | Step | Action |
|---|---|---|
| `lib/nav/groups.ts` | 1 | create |
| `components/nav/GroupDropdown.tsx` | 1 | create |
| `components/nav/MobileNavSheet.tsx` | 1 | create |
| `components/Navbar.tsx` | 1 | rewrite |
| `messages/ja.json`, `messages/ko.json` | 1 (add), 4 (remove) | edit |
| `components/nav/FirmSubNav.tsx` | 2 | create |
| `components/nav/MarketSubNav.tsx` | 2 | create |
| `components/nav/ProduceSubNav.tsx` | 2 | create |
| `app/[locale]/analytics/(firm)/layout.tsx` | 2 | create |
| `app/[locale]/analytics/(market)/layout.tsx` | 2 | create |
| `app/[locale]/analytics/overview/*` | 2 | move into `(firm)/` |
| `app/[locale]/analytics/products/*` | 2 | move into `(firm)/` |
| `app/[locale]/analytics/discovery/*` | 2 | move into `(market)/` |
| `app/[locale]/analytics/strategy/*` | 2 | move into `(market)/` |
| `app/[locale]/analytics/layout.tsx` | 2 | delete |
| `app/[locale]/research/page.tsx` | 3 | create (move home UI) |
| `app/[locale]/page.tsx` | 3 | replace with redirect |
| `app/[locale]/broadcasts/page.tsx` | 4 | edit (add `<MarketSubNav />`) |
| `app/[locale]/screenplays/page.tsx` | 4 | edit (add `<ProduceSubNav />`) |
| `app/[locale]/gallery/page.tsx` | 4 | edit (add `<FirmSubNav />`) |

---

# Step 1 — Top-nav dropdowns (Navbar + groups source-of-truth)

PR scope: replace `components/Navbar.tsx` with a 4-dropdown layout backed by `lib/nav/groups.ts`. Page-level sub-nav is unchanged (still old `/analytics/layout.tsx` with 4 tabs).

### Task 1.1: Add i18n keys for nav groups + members

**Files:**
- Modify: `messages/ja.json` (top of file, in existing `"nav"` object)
- Modify: `messages/ko.json` (top of file, in existing `"nav"` object)

- [ ] **Step 1: Add Japanese keys**

Open `messages/ja.json`. The current `"nav"` object ends around line 11 with `"userManagement": "ユーザー管理"`. Replace the entire `"nav"` block with:

```json
  "nav": {
    "home": "ホーム",
    "products": "商品",
    "reports": "レポート",
    "analytics": "売上分析",
    "gallery": "商品ギャラリー",
    "broadcasts": "番組カレンダー",
    "screenplays": "台本",
    "userManagement": "ユーザー管理",
    "groups": {
      "firm": "自社",
      "market": "市場",
      "produce": "制作",
      "admin": "管理"
    },
    "firm": {
      "overview": "売上概要",
      "products": "商品分析",
      "gallery": "商品ギャラリー"
    },
    "market": {
      "broadcasts": "番組カレンダー",
      "discovery": "新規発掘",
      "strategy": "MD戦略"
    },
    "produce": {
      "screenplays": "番組台本",
      "research": "新規リサーチ"
    },
    "admin": {
      "users": "ユーザー管理",
      "historicalCrawl": "OA収集状況",
      "registry": "スキル登録"
    }
  },
```

(Note: old keys are retained for now; Step 4 removes them.)

- [ ] **Step 2: Add Korean keys**

Open `messages/ko.json`. Replace the entire `"nav"` block with:

```json
  "nav": {
    "home": "홈",
    "products": "상품",
    "reports": "리포트",
    "analytics": "매출 분석",
    "gallery": "상품 이미지",
    "broadcasts": "방송 캘린더",
    "screenplays": "대본",
    "userManagement": "사용자 관리",
    "groups": {
      "firm": "자사",
      "market": "시장",
      "produce": "제작",
      "admin": "관리"
    },
    "firm": {
      "overview": "매출 개요",
      "products": "상품 분석",
      "gallery": "상품 이미지"
    },
    "market": {
      "broadcasts": "방송 캘린더",
      "discovery": "신규 상품 발굴",
      "strategy": "신규 상품 추천"
    },
    "produce": {
      "screenplays": "방송 대본",
      "research": "신규 리서치"
    },
    "admin": {
      "users": "사용자 관리",
      "historicalCrawl": "OA 수집 상태",
      "registry": "스킬 레지스트리"
    }
  },
```

- [ ] **Step 3: Verify both JSON files parse**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('messages/ja.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('messages/ko.json','utf8'))"
```
Expected: no output (both parse successfully). Any error → fix the JSON syntax (trailing comma, mismatched braces).

---

### Task 1.2: Create `lib/nav/groups.ts` — single source of truth

**Files:**
- Create: `lib/nav/groups.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/nav/groups.ts
import type { Role } from '@/lib/auth/route-permissions';

export type GroupKey = 'firm' | 'market' | 'produce' | 'admin';

export interface NavMember {
  /** next-intl translation key, e.g. 'nav.firm.overview' */
  labelKey: string;
  /** Locale-agnostic path; pass through localePath() at render time. */
  href: string;
}

export type GroupVisibility = 'full' | 'productsOnly' | 'hidden';

export interface NavGroup {
  key: GroupKey;
  /** next-intl key for the group label, e.g. 'nav.groups.firm' */
  labelKey: string;
  /** Where clicking the group label goes. */
  landing: string;
  /** Active-matching prefixes (locale-stripped pathname). */
  pathPrefixes: string[];
  members: NavMember[];
  /** Per-role rendering rule. 'productsOnly' = single direct link to /analytics/products. */
  visibility: Record<Role, GroupVisibility>;
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
      { labelKey: 'nav.firm.gallery', href: '/gallery' },
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
      { labelKey: 'nav.market.discovery', href: '/analytics/discovery' },
      { labelKey: 'nav.market.strategy', href: '/analytics/strategy' },
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
      { labelKey: 'nav.produce.research', href: '/research' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'hidden' },
  },
  {
    key: 'admin',
    labelKey: 'nav.groups.admin',
    landing: '/admin/users',
    pathPrefixes: ['/admin/users', '/admin/historical-crawl', '/admin/registry'],
    members: [
      { labelKey: 'nav.admin.users', href: '/admin/users' },
      { labelKey: 'nav.admin.historicalCrawl', href: '/admin/historical-crawl' },
      { labelKey: 'nav.admin.registry', href: '/admin/registry' },
    ],
    visibility: { admin: 'full', member: 'hidden', viewer: 'hidden' },
  },
] as const;

/** Strip the locale prefix ("/ko/..." or "/ja/...") for active-matching. Default locale "ja" has no prefix. */
export function stripLocale(pathname: string): string {
  return pathname.replace(/^\/(?:ja|ko)(?=\/|$)/, '') || '/';
}

/** Returns the group whose pathPrefixes match the given pathname, or null. */
export function findActiveGroup(pathname: string): NavGroup | null {
  const stripped = stripLocale(pathname);
  return (
    NAV_GROUPS.find((g) =>
      g.pathPrefixes.some((p) => stripped === p || stripped.startsWith(p + '/')),
    ) ?? null
  );
}

/** Member of the active group whose href matches the pathname. Used for sub-nav active state. */
export function findActiveMember(group: NavGroup, pathname: string): NavMember | null {
  const stripped = stripLocale(pathname);
  return (
    group.members.find((m) => stripped === m.href || stripped.startsWith(m.href + '/')) ?? null
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors related to `lib/nav/groups.ts`. (Existing baseline errors in `scripts/*`, `.next/types/validator.ts` are unrelated and acceptable.)

- [ ] **Step 3: Commit**

```bash
git add lib/nav/groups.ts messages/ja.json messages/ko.json
git commit -m "feat(nav): add NAV_GROUPS source-of-truth + i18n keys for 4 groups"
```

---

### Task 1.3: Create `components/nav/GroupDropdown.tsx`

A client component that renders a single group: dropdown for `'full'`, single link for `'productsOnly'`, nothing for `'hidden'`.

**Files:**
- Create: `components/nav/GroupDropdown.tsx`

- [ ] **Step 1: Write the file**

```tsx
// components/nav/GroupDropdown.tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { localePath } from '@/lib/i18n/locale-path';
import { findActiveGroup, type NavGroup } from '@/lib/nav/groups';
import type { Role } from '@/lib/auth/route-permissions';

interface Props {
  group: NavGroup;
  role: Role;
  locale: string;
}

export default function GroupDropdown({ group, role, locale }: Props) {
  const pathname = usePathname();
  const visibility = group.visibility[role];
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (visibility === 'hidden') return null;

  const isActive = findActiveGroup(pathname)?.key === group.key;
  const t = useTranslations();

  // 'productsOnly': render single direct link, no dropdown UI
  if (visibility === 'productsOnly') {
    return (
      <Link
        href={localePath(locale, '/analytics/products')}
        className={`text-sm font-medium ${
          isActive ? 'text-blue-600' : 'text-gray-600 hover:text-gray-900'
        }`}
      >
        {t('nav.firm.products')}
      </Link>
    );
  }

  // 'full': dropdown
  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <Link
        href={localePath(locale, group.landing)}
        aria-expanded={open}
        aria-haspopup="menu"
        onFocus={() => setOpen(true)}
        className={`inline-flex items-center gap-1 text-sm font-medium ${
          isActive
            ? 'text-blue-600 border-b-2 border-blue-600 -mb-px'
            : 'text-gray-600 hover:text-gray-900'
        }`}
      >
        {t(group.labelKey)}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </Link>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 min-w-[180px] bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50"
        >
          {group.members.map((m) => (
            <Link
              key={m.href}
              role="menuitem"
              href={localePath(locale, m.href)}
              className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-gray-900"
              onClick={() => setOpen(false)}
            >
              {t(m.labelKey)}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors related to `GroupDropdown.tsx`.

- [ ] **Step 3: Commit**

```bash
git add components/nav/GroupDropdown.tsx
git commit -m "feat(nav): GroupDropdown — hover/focus dropdown with role visibility"
```

---

### Task 1.4: Create `components/nav/MobileNavSheet.tsx`

**Files:**
- Create: `components/nav/MobileNavSheet.tsx`

- [ ] **Step 1: Write the file**

```tsx
// components/nav/MobileNavSheet.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Menu, X } from 'lucide-react';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS } from '@/lib/nav/groups';
import type { Role } from '@/lib/auth/route-permissions';

interface Props {
  role: Role;
  locale: string;
}

export default function MobileNavSheet({ role, locale }: Props) {
  const [open, setOpen] = useState(false);
  const t = useTranslations();

  const groups = NAV_GROUPS.filter((g) => g.visibility[role] !== 'hidden');

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="md:hidden p-2 text-gray-600 hover:text-gray-900"
      >
        <Menu size={20} />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-white md:hidden">
          <div className="flex items-center justify-between h-16 px-4 border-b border-gray-200">
            <span className="text-lg font-bold text-gray-900">MediaWorks</span>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              className="p-2 text-gray-600 hover:text-gray-900"
            >
              <X size={20} />
            </button>
          </div>
          <nav className="p-4 space-y-2">
            {groups.map((g) => {
              if (g.visibility[role] === 'productsOnly') {
                return (
                  <Link
                    key={g.key}
                    href={localePath(locale, '/analytics/products')}
                    onClick={() => setOpen(false)}
                    className="block py-3 px-3 text-base font-medium text-gray-900 rounded-lg hover:bg-gray-50"
                  >
                    {t('nav.firm.products')}
                  </Link>
                );
              }
              return (
                <details key={g.key} className="group">
                  <summary className="flex items-center justify-between py-3 px-3 text-base font-semibold text-gray-900 cursor-pointer rounded-lg hover:bg-gray-50">
                    {t(g.labelKey)}
                    <span className="text-gray-400 group-open:rotate-180 transition-transform">▾</span>
                  </summary>
                  <div className="pl-4 space-y-1 pb-2">
                    {g.members.map((m) => (
                      <Link
                        key={m.href}
                        href={localePath(locale, m.href)}
                        onClick={() => setOpen(false)}
                        className="block py-2 px-3 text-sm text-gray-700 rounded-lg hover:bg-gray-50"
                      >
                        {t(m.labelKey)}
                      </Link>
                    ))}
                  </div>
                </details>
              );
            })}
          </nav>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors related to `MobileNavSheet.tsx`.

- [ ] **Step 3: Commit**

```bash
git add components/nav/MobileNavSheet.tsx
git commit -m "feat(nav): MobileNavSheet — full-screen drawer with <details> per group"
```

---

### Task 1.5: Rewrite `components/Navbar.tsx`

**Files:**
- Modify: `components/Navbar.tsx` (full rewrite)

- [ ] **Step 1: Replace the file**

Overwrite `components/Navbar.tsx` with:

```tsx
// components/Navbar.tsx
import Link from 'next/link';
import { getLocale } from 'next-intl/server';
import LanguageSwitcher from './LanguageSwitcher';
import UserMenu from './UserMenu';
import GroupDropdown from './nav/GroupDropdown';
import MobileNavSheet from './nav/MobileNavSheet';
import { BarChart3 } from 'lucide-react';
import { getServerClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS } from '@/lib/nav/groups';

export default async function Navbar() {
  const locale = await getLocale();

  const sb = await getServerClient();
  const { data: { user } } = await sb.auth.getUser();
  let role: Role | null = null;
  if (user) {
    const { data: profile } = await sb
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    role = (profile?.role ?? null) as Role | null;
  }

  // Logo landing: viewer → /analytics/products, others → /analytics/overview, no role → root.
  const logoHref =
    role === 'viewer'
      ? localePath(locale, '/analytics/products')
      : role
      ? localePath(locale, '/analytics/overview')
      : localePath(locale);

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href={logoHref} className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <BarChart3 size={18} className="text-white" />
            </div>
            <span className="text-lg font-bold text-gray-900">MediaWorks</span>
          </Link>

          {/* Desktop nav */}
          {role && (
            <div className="hidden md:flex items-center gap-6">
              {NAV_GROUPS.map((g) => (
                <GroupDropdown key={g.key} group={g} role={role!} locale={locale} />
              ))}
              <LanguageSwitcher />
              <UserMenu email={user?.email ?? null} role={role} locale={locale} />
            </div>
          )}

          {/* Mobile nav */}
          {role && (
            <div className="flex md:hidden items-center gap-2">
              <LanguageSwitcher />
              <UserMenu email={user?.email ?? null} role={role} locale={locale} />
              <MobileNavSheet role={role} locale={locale} />
            </div>
          )}

          {/* Logged-out fallback (login page itself) */}
          {!role && (
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              <UserMenu email={null} role={null} locale={locale} />
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors. The previous `Activity`, `Calendar`, `Clapperboard`, `Users` imports are gone (now lives inside group components if needed); the previous `getTranslations('nav')` call is gone (group/member labels resolved inside child client components via `useTranslations()`).

- [ ] **Step 3: Manual smoke test — admin role**

```bash
npm run dev
```
Sign in as admin. Visit `localhost:3000`. Expected (desktop):
- Logo + `[자사 ▾] [시장 ▾] [제작 ▾] [관리 ▾]` + language + user menu.
- Hover `[시장]` → dropdown shows 방송 캘린더 / 신규 상품 발굴 / 신규 상품 추천.
- Click `[시장]` label itself → navigates to `/broadcasts`.
- Click a dropdown item → navigates to that page; on that page, the corresponding group label gets blue underline.
- Resize to <768px → top-nav collapses to language/user/hamburger. Click hamburger → sheet opens with 4 `<details>` groups.

- [ ] **Step 4: Manual smoke test — member role**

Sign in as member (or temporarily change a profile row in Supabase). Visit `localhost:3000`.
Expected: identical to admin **except** `[관리]` dropdown is absent.

- [ ] **Step 5: Manual smoke test — viewer role**

Sign in as viewer. Expected:
- Top-nav shows `[상품 분석]` as a single direct link (no chevron, no dropdown), language, user menu.
- No `[시장]`, `[제작]`, `[관리]` visible.
- Click logo → `/analytics/products`.

- [ ] **Step 6: Commit + open PR**

```bash
git add components/Navbar.tsx
git commit -m "feat(nav): replace flat top-nav with 4 dropdown groups"
git push -u origin HEAD
gh pr create --title "feat(nav): restructure top-nav into 4 groups" --body "Step 1 of nav restructure plan (docs/superpowers/plans/2026-05-17-nav-restructure.md). Replaces flat nav with dropdown-based 4-group layout (자사/시장/제작/관리) driven by lib/nav/groups.ts. Page-level sub-nav (the 4-tab analytics layout) unchanged in this PR — Step 2 follows immediately."
```

---

# Step 2 — Split `/analytics` into `(firm)` and `(market)` route groups

PR scope: page-level sub-nav becomes group-consistent. URLs stay identical. `useAnalyticsFilter` context moves into `(firm)/layout.tsx`.

### Task 2.1: Create sub-nav components

**Files:**
- Create: `components/nav/FirmSubNav.tsx`
- Create: `components/nav/MarketSubNav.tsx`
- Create: `components/nav/ProduceSubNav.tsx`

These three components share an identical shape but live as separate files for clarity (each consumes one group from `NAV_GROUPS`). If you find yourself adding a 4th, refactor into a single `<GroupSubNav groupKey="..." />` then.

- [ ] **Step 1: Write `FirmSubNav.tsx`**

```tsx
// components/nav/FirmSubNav.tsx
'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS, findActiveMember } from '@/lib/nav/groups';

const GROUP = NAV_GROUPS.find((g) => g.key === 'firm')!;

export default function FirmSubNav() {
  const { locale } = useParams<{ locale: string }>();
  const pathname = usePathname();
  const t = useTranslations();
  const activeHref = findActiveMember(GROUP, pathname)?.href ?? null;

  return (
    <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm w-fit">
      {GROUP.members.map((m) => {
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

- [ ] **Step 2: Write `MarketSubNav.tsx`**

Same body as `FirmSubNav.tsx` but with `GROUP = NAV_GROUPS.find((g) => g.key === 'market')!;`.

```tsx
// components/nav/MarketSubNav.tsx
'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS, findActiveMember } from '@/lib/nav/groups';

const GROUP = NAV_GROUPS.find((g) => g.key === 'market')!;

export default function MarketSubNav() {
  const { locale } = useParams<{ locale: string }>();
  const pathname = usePathname();
  const t = useTranslations();
  const activeHref = findActiveMember(GROUP, pathname)?.href ?? null;

  return (
    <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm w-fit">
      {GROUP.members.map((m) => {
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

- [ ] **Step 3: Write `ProduceSubNav.tsx`**

```tsx
// components/nav/ProduceSubNav.tsx
'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS, findActiveMember } from '@/lib/nav/groups';

const GROUP = NAV_GROUPS.find((g) => g.key === 'produce')!;

export default function ProduceSubNav() {
  const { locale } = useParams<{ locale: string }>();
  const pathname = usePathname();
  const t = useTranslations();
  const activeHref = findActiveMember(GROUP, pathname)?.href ?? null;

  return (
    <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm w-fit">
      {GROUP.members.map((m) => {
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

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors related to the three sub-nav files.

- [ ] **Step 5: Commit**

```bash
git add components/nav/FirmSubNav.tsx components/nav/MarketSubNav.tsx components/nav/ProduceSubNav.tsx
git commit -m "feat(nav): per-group SubNav components (Firm/Market/Produce)"
```

---

### Task 2.2: Move overview/products into `(firm)` route group + new layout with filter context

**Files:**
- Create: `app/[locale]/analytics/(firm)/layout.tsx`
- Move: `app/[locale]/analytics/overview/page.tsx` → `app/[locale]/analytics/(firm)/overview/page.tsx`
- Move: `app/[locale]/analytics/products/*` → `app/[locale]/analytics/(firm)/products/*` (entire subtree, including `[code]/page.tsx`)

Route groups are wrapped in parentheses `(firm)` and **do not affect URLs**. `/analytics/overview` remains `/analytics/overview`.

- [ ] **Step 1: Move overview**

```bash
git mv app/[locale]/analytics/overview app/[locale]/analytics/\(firm\)/overview
```

(On Windows PowerShell: `git mv 'app/[locale]/analytics/overview' 'app/[locale]/analytics/(firm)/overview'` — the parens are valid filesystem characters; the shell may need quoting.)

- [ ] **Step 2: Move products subtree**

```bash
git mv app/[locale]/analytics/products app/[locale]/analytics/\(firm\)/products
```

- [ ] **Step 3: Create `(firm)/layout.tsx`**

Create `app/[locale]/analytics/(firm)/layout.tsx`. This file replaces the filter context + `<FirmSubNav />` portion of the old `analytics/layout.tsx`.

```tsx
// app/[locale]/analytics/(firm)/layout.tsx
'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';
import DateRangeFilter from '@/components/analytics/DateRangeFilter';
import FirmSubNav from '@/components/nav/FirmSubNav';

type Period = 'weekly' | 'monthly';

interface AnalyticsFilterContextValue {
  selectedYears: number[];
  setSelectedYears: (y: number[]) => void;
  period: Period;
  setPeriod: (p: Period) => void;
}

const AnalyticsFilterContext = createContext<AnalyticsFilterContextValue | null>(null);

export function useAnalyticsFilter(): AnalyticsFilterContextValue {
  const ctx = useContext(AnalyticsFilterContext);
  if (!ctx) throw new Error('useAnalyticsFilter must be used inside (firm) layout');
  return ctx;
}

export default function FirmLayout({ children }: { children: ReactNode }) {
  const [selectedYears, setSelectedYears] = useState<number[]>([2025, 2026]);
  const [period, setPeriod] = useState<Period>('weekly');

  return (
    <AnalyticsFilterContext.Provider
      value={{ selectedYears, setSelectedYears, period, setPeriod }}
    >
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={20} className="text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">自社データ</h1>
          </div>
          <p className="text-sm text-gray-500">売上・商品・ギャラリー</p>
        </div>

        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <FirmSubNav />
            <DateRangeFilter
              years={[2025, 2026]}
              selectedYears={selectedYears}
              period={period}
              onYearsChange={setSelectedYears}
              onPeriodChange={setPeriod}
            />
          </div>
          {children}
        </div>
      </main>
    </AnalyticsFilterContext.Provider>
  );
}
```

- [ ] **Step 4: Update import in `overview/page.tsx`**

Open `app/[locale]/analytics/(firm)/overview/page.tsx`. Find the import line:

```ts
import { useAnalyticsFilter } from '../layout';
```

Replace with:

```ts
import { useAnalyticsFilter } from '../layout';
```

(The relative path stays the same — `overview/page.tsx` and the new `(firm)/layout.tsx` are still siblings in the route-group sense. Verify the import resolves by running typecheck.)

- [ ] **Step 5: Update import in `products/page.tsx`**

Open `app/[locale]/analytics/(firm)/products/page.tsx`. Same `import { useAnalyticsFilter } from '../layout';` — unchanged (relative path still works inside the route group).

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors. If `useAnalyticsFilter` import fails to resolve, double-check that `(firm)/layout.tsx` exports `useAnalyticsFilter` (it does, per Step 3).

- [ ] **Step 7: Commit**

```bash
git add -A app/\[locale\]/analytics/\(firm\)
git commit -m "feat(nav): move overview/products into (firm) route group with filter context"
```

---

### Task 2.3: Move discovery/strategy into `(market)` route group + new layout

**Files:**
- Create: `app/[locale]/analytics/(market)/layout.tsx`
- Move: `app/[locale]/analytics/discovery/*` → `app/[locale]/analytics/(market)/discovery/*`
- Move: `app/[locale]/analytics/strategy/*` → `app/[locale]/analytics/(market)/strategy/*`

- [ ] **Step 1: Move both subtrees**

```bash
git mv app/[locale]/analytics/discovery app/[locale]/analytics/\(market\)/discovery
git mv app/[locale]/analytics/strategy app/[locale]/analytics/\(market\)/strategy
```

- [ ] **Step 2: Create `(market)/layout.tsx`**

```tsx
// app/[locale]/analytics/(market)/layout.tsx
import type { ReactNode } from 'react';
import { Globe2 } from 'lucide-react';
import MarketSubNav from '@/components/nav/MarketSubNav';

export default function MarketLayout({ children }: { children: ReactNode }) {
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Globe2 size={20} className="text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">市場リサーチ</h1>
        </div>
        <p className="text-sm text-gray-500">番組カレンダー・新規発掘・MD戦略</p>
      </div>
      <div className="space-y-6">
        <MarketSubNav />
        {children}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add -A app/\[locale\]/analytics/\(market\)
git commit -m "feat(nav): move discovery/strategy into (market) route group"
```

---

### Task 2.4: Delete old `analytics/layout.tsx` and `analytics/page.tsx`

**Files:**
- Delete: `app/[locale]/analytics/layout.tsx`
- Modify: `app/[locale]/analytics/page.tsx` (currently redirects to `/analytics/overview` — keep as is, it still works)

- [ ] **Step 1: Delete the old layout**

```bash
git rm app/\[locale\]/analytics/layout.tsx
```

- [ ] **Step 2: Verify analytics/page.tsx still works**

Open `app/[locale]/analytics/page.tsx` and confirm it redirects to `/analytics/overview`. No changes needed (it's a server-side `redirect()`). The redirect target is now inside `(firm)`, but the URL is identical, so it resolves.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors. (If overview/products import `useAnalyticsFilter` from `'../layout'`, that now resolves to `(firm)/layout.tsx` — confirm.)

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```
- Visit `/analytics/overview` → page renders, header says `自社データ`, sub-nav shows `[売上概要] [商品分析] [商品ギャラリー]`, filter visible. Active tab = `売上概要`.
- Visit `/analytics/products` → same layout, active tab = `商品分析`.
- Visit `/analytics/discovery` → header says `市場リサーチ`, sub-nav shows `[番組カレンダー] [新規発掘] [MD戦略]`, **no filter**. Active tab = `新規発掘`.
- Visit `/analytics/strategy` → same layout, active tab = `MD戦略`.
- Click sub-nav tabs across both groups, confirm correct active state.

- [ ] **Step 5: Commit + open PR**

```bash
git add -A
git commit -m "refactor(nav): remove monolithic analytics/layout.tsx (split into (firm)/(market))"
git push
gh pr create --title "feat(nav): split /analytics into (firm) and (market) route groups" --body "Step 2 of nav restructure plan. Splits the monolithic /analytics/layout.tsx into two route groups; URLs unchanged. AnalyticsFilterContext now scoped to (firm) where it's actually used. After this PR + Step 1, page-level sub-nav matches the top-nav grouping."
```

---

# Step 3 — `/research` + role-based root redirect

PR scope: home page (upload + recent products list) moves to `/research`; `/` becomes a server-side redirect.

### Task 3.1: Create `/research` page (copy of current home)

**Files:**
- Create: `app/[locale]/research/page.tsx`

- [ ] **Step 1: Copy current home content**

Create `app/[locale]/research/page.tsx`:

```tsx
// app/[locale]/research/page.tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import FileUpload from '@/components/FileUpload';
import ProductList from '@/components/ProductList';
import { Sparkles } from 'lucide-react';

export default function ResearchPage() {
  const t = useTranslations('home');
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleUploadComplete = () => {
    setRefreshTrigger((n) => n + 1);
  };

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 text-sm font-medium px-4 py-2 rounded-full mb-4">
          <Sparkles size={14} />
          AI-Powered Research
        </div>
        <h1 className="text-4xl font-bold text-gray-900 mb-3">{t('title')}</h1>
        <p className="text-lg text-gray-500 max-w-2xl mx-auto">{t('description')}</p>
      </div>

      <div className="max-w-2xl mx-auto mb-16">
        <FileUpload onUploadComplete={handleUploadComplete} />
      </div>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-6">{t('recentProducts')}</h2>
        <ProductList refreshTrigger={refreshTrigger} />
      </section>
    </main>
  );
}
```

(This is the verbatim content from the current `app/[locale]/page.tsx`. Translation namespace `home` is reused — Step 4 may rename it; for now we don't touch i18n.)

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 3: Smoke test**

```bash
npm run dev
```
Visit `/research`. Expected: page renders with upload card + recent product list, identical to current `/`. Upload a file → product appears in list, click `view report` → redirects to `/products/[id]` correctly.

- [ ] **Step 4: Commit**

```bash
git add app/\[locale\]/research/page.tsx
git commit -m "feat(nav): add /research route (home upload UI moved here)"
```

---

### Task 3.2: Replace `/` with role-based redirect

**Files:**
- Modify: `app/[locale]/page.tsx` (full replace)

Note: `proxy.ts` (middleware) already handles two cases before the page runs:
- Unauthenticated user hitting `/` → redirected to `/login` (line 41-43 of `proxy.ts`).
- Viewer hitting `/` → redirected to `/analytics/products` (line 45-47, since `/` is not in `VIEWER_ALLOWED_PATH_PREFIXES`).

So the page component only needs to handle authenticated admin/member.

- [ ] **Step 1: Replace `page.tsx`**

Overwrite `app/[locale]/page.tsx`:

```tsx
// app/[locale]/page.tsx
import { redirect } from 'next/navigation';
import { localePath } from '@/lib/i18n/locale-path';

export default async function RootRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Middleware (proxy.ts) already redirects unauthenticated → /login and viewer → /analytics/products.
  // Anyone reaching this component is admin or member.
  redirect(localePath(locale, '/analytics/overview'));
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: no new errors. The old `'use client'`, `useState`, and component imports are gone.

- [ ] **Step 3: Smoke test — admin**

```bash
npm run dev
```
Sign in as admin. Visit `localhost:3000/` (default locale, no `/ja` prefix). Expected: instant redirect to `/analytics/overview`. URL bar updates.

- [ ] **Step 4: Smoke test — member**

Sign in as member. Visit `localhost:3000/`. Expected: redirect to `/analytics/overview`.

- [ ] **Step 5: Smoke test — viewer**

Sign in as viewer. Visit `localhost:3000/`. Expected: redirect to `/analytics/products` (handled by middleware before the page redirect runs).

- [ ] **Step 6: Smoke test — unauthenticated**

Sign out. Visit `localhost:3000/`. Expected: redirect to `/login` (handled by middleware).

- [ ] **Step 7: Smoke test — `/ko` locale variant**

Visit `localhost:3000/ko` while signed in as admin. Expected: redirect to `/ko/analytics/overview`.

- [ ] **Step 8: Commit + open PR**

```bash
git add app/\[locale\]/page.tsx
git commit -m "feat(nav): replace / with role-based redirect (admin/member → /analytics/overview)"
git push
gh pr create --title "feat(nav): /research + root role-redirect" --body "Step 3 of nav restructure plan. Moves home upload UI to /research (under 制作 group). / becomes a server redirect to the role's landing page (relies on existing middleware for unauthenticated + viewer cases)."
```

---

# Step 4 — Cross-segment sub-nav + i18n cleanup

PR scope: `/broadcasts`, `/screenplays`, `/research`, `/gallery` get their group sub-nav; obsolete `nav.*` keys removed.

### Task 4.1: Add `<MarketSubNav />` to `/broadcasts`

**Files:**
- Modify: `app/[locale]/broadcasts/page.tsx`

- [ ] **Step 1: Read the file**

Open `app/[locale]/broadcasts/page.tsx` to find the top-level `<main>` (or equivalent container).

- [ ] **Step 2: Insert sub-nav**

Add the import at the top:

```tsx
import MarketSubNav from '@/components/nav/MarketSubNav';
```

Inside the top-level container (after the page header, before the main content), insert:

```tsx
<MarketSubNav />
```

If the page uses a top-level fragment or `<div>` and has its own padding, wrap the sub-nav so it lines up with the rest:

```tsx
<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
  <MarketSubNav />
</div>
```

Match the page's existing container width (`max-w-7xl` is the convention used in analytics layouts).

- [ ] **Step 3: Typecheck + smoke test**

```bash
npx tsc --noEmit
npm run dev
```
Visit `/broadcasts`. Expected: top of the page now shows `[番組カレンダー] [新規発掘] [MD戦略]` with `番組カレンダー` active. Click `新規発掘` → goes to `/analytics/discovery`, active state updates.

- [ ] **Step 4: Commit**

```bash
git add app/\[locale\]/broadcasts/page.tsx
git commit -m "feat(nav): MarketSubNav on /broadcasts"
```

---

### Task 4.2: Add `<ProduceSubNav />` to `/screenplays` and `/research`

**Files:**
- Modify: `app/[locale]/screenplays/page.tsx`
- Modify: `app/[locale]/research/page.tsx`

- [ ] **Step 1: Modify screenplays**

Open `app/[locale]/screenplays/page.tsx`. Add import:

```tsx
import ProduceSubNav from '@/components/nav/ProduceSubNav';
```

Insert `<ProduceSubNav />` near the top of the rendered output, inside the existing container (match the convention from Task 4.1).

- [ ] **Step 2: Modify research**

Open `app/[locale]/research/page.tsx`. Add import:

```tsx
import ProduceSubNav from '@/components/nav/ProduceSubNav';
```

Right after the `<main className="...">` opening tag and before the hero section, insert:

```tsx
<div className="mb-8">
  <ProduceSubNav />
</div>
```

- [ ] **Step 3: Typecheck + smoke test**

```bash
npx tsc --noEmit
npm run dev
```
Visit `/screenplays` → sub-nav shows `[番組台本] [新規リサーチ]` with `番組台本` active.
Visit `/research` → same sub-nav, `新規リサーチ` active. Click `番組台本` → goes to `/screenplays`.

- [ ] **Step 4: Commit**

```bash
git add app/\[locale\]/screenplays/page.tsx app/\[locale\]/research/page.tsx
git commit -m "feat(nav): ProduceSubNav on /screenplays and /research"
```

---

### Task 4.3: Add `<FirmSubNav />` to `/gallery`

**Files:**
- Modify: `app/[locale]/gallery/page.tsx`

- [ ] **Step 1: Modify gallery**

Open `app/[locale]/gallery/page.tsx`. Add import:

```tsx
import FirmSubNav from '@/components/nav/FirmSubNav';
```

Insert `<FirmSubNav />` near the top of the rendered output, inside the existing container (match the convention from Tasks 4.1-4.2).

- [ ] **Step 2: Typecheck + smoke test**

```bash
npx tsc --noEmit
npm run dev
```
Visit `/gallery` → sub-nav shows `[売上概要] [商品分析] [商品ギャラリー]` with `商品ギャラリー` active.

- [ ] **Step 3: Commit**

```bash
git add app/\[locale\]/gallery/page.tsx
git commit -m "feat(nav): FirmSubNav on /gallery"
```

---

### Task 4.4: Remove unused i18n keys

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`

The current `Navbar.tsx` does not call `getTranslations('nav')` anymore, and group components use `nav.groups.*` / `nav.firm.*` / `nav.market.*` / `nav.produce.*` / `nav.admin.*`. The following old keys are confirmed unused:
- `nav.home`, `nav.products`, `nav.reports`, `nav.analytics`, `nav.gallery`, `nav.broadcasts`, `nav.screenplays`, `nav.userManagement`.

Verify by grepping the codebase first.

- [ ] **Step 1: Verify keys are unused**

```bash
```

Use Grep tool (not bash):
- Pattern: `t\(['"](home|products|reports|analytics|gallery|broadcasts|screenplays|userManagement)['"]\)`
- Search in `app/`, `components/`, `lib/`.

For each match, the call has to come from a `useTranslations('nav')` or `getTranslations('nav')` scope to count. Inspect each match to confirm none come from the `nav` namespace.

If any do, leave that key in place and document the exception in the commit message.

- [ ] **Step 2: Remove from `messages/ja.json`**

Open `messages/ja.json`. In the `"nav"` block (lines ~2-30), delete the 8 old keys, keeping only `groups`, `firm`, `market`, `produce`, `admin`:

```json
  "nav": {
    "groups": { ... },
    "firm": { ... },
    "market": { ... },
    "produce": { ... },
    "admin": { ... }
  },
```

- [ ] **Step 3: Remove from `messages/ko.json`**

Same operation on `messages/ko.json`.

- [ ] **Step 4: Verify JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/ja.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('messages/ko.json','utf8'))"
```
Expected: no output.

- [ ] **Step 5: Typecheck + smoke test all routes**

```bash
npx tsc --noEmit
npm run dev
```
Walk through each role:
- admin: logo → `/analytics/overview`. Visit each of the 11 member pages (overview, products, gallery, broadcasts, discovery, strategy, screenplays, research, admin/users, admin/historical-crawl, admin/registry). Sub-nav active state correct on every one.
- member: same minus `admin/*`.
- viewer: top-nav shows only `[商品分析]`; visiting `/` redirects to `/analytics/products`; cannot reach anything else.

- [ ] **Step 6: Commit + open PR**

```bash
git add messages/ja.json messages/ko.json
git commit -m "chore(i18n): remove obsolete top-level nav keys (subsumed by nav.groups.*/nav.{firm,market,produce,admin}.*)"
git push
gh pr create --title "feat(nav): cross-segment sub-nav + i18n cleanup" --body "Step 4 of nav restructure plan. /broadcasts, /screenplays, /research, /gallery now render their group's sub-nav. Obsolete nav.* i18n keys removed. After this PR, IA is fully reflected in code surface."
```

---

## Self-Review (already performed before plan was published)

**1. Spec coverage**
- §2 IA tables → Task 1.2 (NAV_GROUPS) + Task 1.1 (i18n).
- §3 Nav UI animation/active state → Task 1.3 (GroupDropdown) + Task 1.4 (MobileNavSheet).
- §3 sub-nav → Task 2.1 + Task 2.2-2.4 + Task 4.1-4.3.
- §4.1 source of truth → Task 1.2.
- §4.2 route group split → Task 2.2 + 2.3 + 2.4.
- §4.3 `/research` + `/` redirect → Task 3.1 + 3.2.
- §4.4 cross-segment sub-nav → Task 4.1 + 4.2 + 4.3.
- §4.5 file table → File map at top.
- §4.6 i18n → Task 1.1 (add) + Task 4.4 (remove).
- §5 rollout → 4 Steps = 4 PRs.
- §6 risk 1 (`useAnalyticsFilter`) → covered by Task 2.2 (filter context lives in `(firm)/layout.tsx`; spec already validated only overview/products use it).
- §6 risk 2 (`/` redirect auth) → covered by Task 3.2 (relies on middleware-handled cases).
- §6 risk 3 (cross-segment drift) → covered by sub-nav components consuming `NAV_GROUPS` directly.
- §6 risk 4 (viewer single-link UX) → covered by Task 1.3 `'productsOnly'` branch.
- §8 verification scenarios 1-8 → smoke-test steps inside Task 1.5, Task 2.4, Task 3.2, Task 4.4.

**2. Placeholders**
- No "TBD", "TODO", "similar to Task N", "handle edge cases". Code blocks are complete.

**3. Type consistency**
- `Role` type: imported consistently from `@/lib/auth/route-permissions`.
- `useAnalyticsFilter` signature: identical between old and new layout.
- `NAV_GROUPS` member type matches usage in all four consumers (`GroupDropdown`, `MobileNavSheet`, three SubNav components).
- `localePath(locale, href)` call signature consistent everywhere.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-nav-restructure.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
