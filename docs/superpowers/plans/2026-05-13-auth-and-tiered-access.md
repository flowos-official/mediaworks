# Auth & Tiered Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Supabase-Auth-based invite-only authentication and three-role (admin / member / viewer) access control to the MediaWorks platform, gated by middleware, API checks, and Postgres RLS.

**Architecture:** Three-layer defence — `proxy.ts` redirects (UX), `requireUser()` API gate (logical), Postgres RLS (last line). Session lives in httpOnly cookies via `@supabase/ssr`. Viewer can read only the TXD product analytics surface; member/admin keep full app access; feedback gains `user_id` attribution.

**Tech Stack:** Next.js 16 App Router, `@supabase/supabase-js` 2.99, NEW `@supabase/ssr`, next-intl 4.8, Supabase Postgres + Auth, shadcn/ui.

**Source spec:** `docs/superpowers/specs/2026-05-13-auth-and-tiered-access-design.md` (commit 5af4546).

**Branch:** `worktree-feat-auth-tiered-access` (worktree at `.claude/worktrees/feat-auth-tiered-access`).

---

## Inventory (resolved from live codebase)

**Tables / views in use** (from `grep .from(...)` across `app/api/**` and `lib/**`):

- TXD (Group A — viewer-readable):
  `product_details`, `product_images`, `sales_weekly`, `sales_weekly_totals`,
  `product_summaries` (view), `monthly_summaries` (view)
- Internal (Group B):
  `products`, `product_files`, `research_results`,
  `discovered_products`, `discovery_runs`, `discovery_sessions`,
  `discovery_product_analyses`, `learning_state`, `learning_insights`,
  `broadcasts`, `qvc_products`,
  `md_strategies`, `live_commerce_strategies`,
  `category_summaries` (view), `annual_summaries` (view)
- Feedback (Group C): `product_feedback`
- New (Group D): `profiles`
- Storage bucket: `product-files`

**Route files** (from `glob app/api/**/route.ts`):

- Cron (CRON_SECRET only): `app/api/cron/daily-broadcasts`, `daily-discovery`, `daily-discovery-home`, `daily-discovery-live`, `daily-learning`, `daily-refresh`, `weekly-insights`.
- Internal-triggered worker (CRON_SECRET-style internal header): `app/api/analyze/synthesize`, `app/api/discovery/enrich/[productId]/worker`.
- User-polling (member/admin session): `app/api/analytics/md-strategy/run/[runId]/status`, `…/stream`, `app/api/analytics/live-commerce/run/[runId]/status`, `…/stream`.
- Viewer-allowed (admin/member/viewer): `app/api/analytics/products` (GET), `app/api/analytics/products/[code]` (GET), `app/api/analytics/products/[code]/images` (GET).
- Member/admin: all other `app/api/*` except those above and `/admin/*`.
- Admin-only (new): `app/api/admin/users`, `app/api/admin/users/[id]`.
- Mixed (admin OR CRON_SECRET): `app/api/broadcasts/refresh` (already CRON_SECRET; add admin session fallback).
- Manual heavy trigger (admin-only): `app/api/discovery/manual-trigger`.

---

## Phase 1 — Schema + loose RLS (deployable, no behavior change)

### Task 1: Migration 01 — profiles, helper, feedback.user_id

**Files:**
- Create: `supabase/migrations/2026-05-13_auth_schema.sql`

- [ ] **Step 1: Write the SQL migration**

```sql
-- 2026-05-13_auth_schema.sql

-- profiles: 1:1 with auth.users, app-owned role
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'viewer'
    check (role in ('admin','member','viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);

-- Auto-create profile row whenever an auth.users row appears
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'viewer')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Track who submitted each feedback row (nullable for pre-auth rows)
alter table public.product_feedback
  add column if not exists user_id uuid references public.profiles(id)
  on delete set null;

create index if not exists product_feedback_user_id_created_idx
  on public.product_feedback (user_id, created_at desc);

-- Helper function reused by every RLS policy
create or replace function public.current_user_role() returns text
  language sql security definer stable set search_path = public as $$
    select role from public.profiles where id = auth.uid()
$$;

-- Trigger to forbid non-admin role changes
create or replace function public.prevent_role_self_escalation() returns trigger
  language plpgsql as $$
begin
  if new.role is distinct from old.role
     and (public.current_user_role() is null or public.current_user_role() <> 'admin') then
    raise exception 'role can only be changed by admin';
  end if;
  return new;
end $$;

drop trigger if exists profiles_no_self_escalate on public.profiles;
create trigger profiles_no_self_escalate
  before update on public.profiles
  for each row execute function public.prevent_role_self_escalation();
```

- [ ] **Step 2: Apply migration to Supabase**

Open Supabase Studio → SQL Editor → paste contents of the file → Run.
(There is no `supabase` CLI workflow configured in this repo; migrations live in `supabase/migrations/` as documentation and are applied manually.)

- [ ] **Step 3: Verify schema**

In Supabase Studio SQL Editor:

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='profiles'
order by ordinal_position;
```

Expected: 6 rows (id, email, display_name, role, created_at, updated_at).

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='product_feedback' and column_name='user_id';
```

Expected: 1 row (user_id).

```sql
select public.current_user_role();
```

Expected: NULL (since the SQL Editor session has no auth.uid).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-13_auth_schema.sql
git commit -m "feat(auth): add profiles, role trigger, feedback.user_id, RLS helpers"
```

---

### Task 2: Migration 02 — Enable RLS with loose policies (anon preserved)

**Files:**
- Create: `supabase/migrations/2026-05-13_auth_rls_loose.sql`

- [ ] **Step 1: Write the SQL migration**

```sql
-- 2026-05-13_auth_rls_loose.sql
-- Enables RLS on every public table touched by the app, with permissive
-- "using (true)" policies so existing anon/service-role behavior is preserved.
-- Phase 5 will tighten these to role-based policies.

-- Group A (TXD)
alter table public.product_details      enable row level security;
alter table public.product_images       enable row level security;
alter table public.sales_weekly         enable row level security;
alter table public.sales_weekly_totals  enable row level security;

-- Group B (internal)
alter table public.products                     enable row level security;
alter table public.product_files                enable row level security;
alter table public.research_results             enable row level security;
alter table public.discovered_products          enable row level security;
alter table public.discovery_runs               enable row level security;
alter table public.discovery_sessions           enable row level security;
alter table public.discovery_product_analyses   enable row level security;
alter table public.learning_state               enable row level security;
alter table public.learning_insights            enable row level security;
alter table public.broadcasts                   enable row level security;
alter table public.qvc_products                 enable row level security;
alter table public.md_strategies                enable row level security;
alter table public.live_commerce_strategies     enable row level security;

-- Group C
alter table public.product_feedback enable row level security;

-- Group D
alter table public.profiles enable row level security;

-- Loose policies — every authenticated user can do everything for now.
-- These are temporary; Phase 5 (Task 22) will drop them and add role-based ones.
do $$
declare t text;
begin
  foreach t in array array[
    'product_details','product_images','sales_weekly','sales_weekly_totals',
    'products','product_files','research_results',
    'discovered_products','discovery_runs','discovery_sessions','discovery_product_analyses',
    'learning_state','learning_insights','broadcasts','qvc_products',
    'md_strategies','live_commerce_strategies','product_feedback','profiles'
  ] loop
    execute format('drop policy if exists "loose_all" on public.%I', t);
    execute format(
      'create policy "loose_all" on public.%I for all to authenticated, anon using (true) with check (true)', t
    );
  end loop;
end $$;
```

- [ ] **Step 2: Apply migration**

Studio → SQL Editor → run.

- [ ] **Step 3: Verify**

```sql
select tablename, rowsecurity
from pg_tables
where schemaname='public' and tablename in
  ('profiles','product_feedback','discovered_products','product_details');
```

Expected: every row has `rowsecurity = true`.

```sql
select tablename, policyname from pg_policies
where schemaname='public' and policyname='loose_all'
order by tablename;
```

Expected: 19 rows.

- [ ] **Step 4: Smoke-test that anon reads still work**

```bash
curl -sS "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/products?select=id&limit=1" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

Expected: HTTP 200 + JSON array. (Existing app continues to work.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-05-13_auth_rls_loose.sql
git commit -m "feat(auth): enable RLS on all public tables with loose policies"
```

---

### Task 3: Migration 03 — Storage policies for product-files bucket

**Files:**
- Create: `supabase/migrations/2026-05-13_auth_storage.sql`

- [ ] **Step 1: Write the SQL migration**

```sql
-- 2026-05-13_auth_storage.sql
-- product-files bucket is currently public — keep it public for now (Phase 1).
-- Phase 5 will tighten via a follow-up if needed.
-- This migration documents intent and leaves room for future policies.

-- Ensure bucket exists with current public flag preserved.
insert into storage.buckets (id, name, public)
values ('product-files', 'product-files', true)
on conflict (id) do update set public = excluded.public;

-- (Intentionally no storage.objects policies in Phase 1 — relies on bucket-level public)
```

- [ ] **Step 2: Apply migration**

Studio → SQL Editor → run.

- [ ] **Step 3: Verify**

```sql
select id, name, public from storage.buckets where id='product-files';
```

Expected: 1 row, `public=true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-13_auth_storage.sql
git commit -m "feat(auth): document product-files bucket state (public, Phase 1)"
```

---

## Phase 2 — Auth library code (not yet referenced)

### Task 4: Install @supabase/ssr

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install dependency**

```bash
npm install @supabase/ssr@latest
```

- [ ] **Step 2: Confirm version pinned**

Open `package.json`, confirm `@supabase/ssr` is listed under `dependencies` with a concrete version (e.g. `^0.5.x`).

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(auth): add @supabase/ssr dependency"
```

---

### Task 5: Add lib/supabase/server.ts

**Files:**
- Create: `lib/supabase/server.ts`

- [ ] **Step 1: Write the helper**

```ts
// lib/supabase/server.ts
import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Server Supabase client that reads/writes the user's session cookies.
 * RLS applies. Use from Server Components, API routes, and Server Actions
 * that act on behalf of a logged-in user.
 *
 * Do NOT use for cron/background jobs — those keep using getServiceClient().
 */
export async function getServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const cookieMethods: CookieMethodsServer = {
    getAll: () => cookieStore.getAll(),
    setAll: (toSet) => {
      for (const { name, value, options } of toSet) {
        try {
          cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; middleware will refresh instead.
        }
      }
    },
  };
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: cookieMethods },
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add lib/supabase/server.ts
git commit -m "feat(auth): add getServerClient (cookie-based, RLS-applied)"
```

---

### Task 6: Add lib/supabase/middleware.ts (session refresh)

**Files:**
- Create: `lib/supabase/middleware.ts`

- [ ] **Step 1: Write the middleware helper**

```ts
// lib/supabase/middleware.ts
import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

type Role = 'admin' | 'member' | 'viewer';

export interface SessionInfo {
  response: NextResponse;
  user: { id: string; email: string | undefined } | null;
  role: Role | null;
}

/**
 * Reads the request's session cookies, refreshes them if needed, and returns:
 *  - response: NextResponse with refreshed cookies attached (always use this)
 *  - user:    null if unauthenticated, else { id, email }
 *  - role:    null if unauthenticated, else 'admin' | 'member' | 'viewer'
 */
export async function updateSession(req: NextRequest): Promise<SessionInfo> {
  let response = NextResponse.next({ request: req });
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) {
            req.cookies.set(name, value);
          }
          response = NextResponse.next({ request: req });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { response, user: null, role: null };

  const { data: profile } = await sb
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  const role = (profile?.role ?? null) as Role | null;
  return { response, user: { id: user.id, email: user.email }, role };
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add lib/supabase/middleware.ts
git commit -m "feat(auth): add updateSession middleware helper"
```

---

### Task 7: Add lib/auth/route-permissions.ts

**Files:**
- Create: `lib/auth/route-permissions.ts`

- [ ] **Step 1: Write the constant**

```ts
// lib/auth/route-permissions.ts
export type Role = 'admin' | 'member' | 'viewer';

/** All three roles can read these page paths (just viewer-allowed list below). */
export const VIEWER_ALLOWED_PATH_PREFIXES = [
  '/analytics/products', // covers /[locale]/analytics/products and /[locale]/analytics/products/[code]
] as const;

/**
 * Given a pathname like "/ja/analytics/products/12345", returns true if a
 * viewer is permitted to load it. Locale segment is stripped first.
 */
export function isViewerAllowedPath(pathname: string): boolean {
  const stripped = pathname.replace(/^\/(?:en|ja)(?=\/|$)/, '') || '/';
  return VIEWER_ALLOWED_PATH_PREFIXES.some((prefix) =>
    stripped === prefix || stripped.startsWith(prefix + '/'),
  );
}

/**
 * Default role landing pages after login.
 */
export const ROLE_LANDING: Record<Role, string> = {
  admin: '/',
  member: '/',
  viewer: '/analytics/products',
};
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add lib/auth/route-permissions.ts
git commit -m "feat(auth): add route permission constants"
```

---

### Task 8: Add lib/auth/require-user.ts

**Files:**
- Create: `lib/auth/require-user.ts`

- [ ] **Step 1: Write the helper**

```ts
// lib/auth/require-user.ts
import { NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getServerClient } from '@/lib/supabase/server';
import type { Role } from './route-permissions';

export type RequireUserResult =
  | { error: NextResponse }
  | { user: User; role: Role; sb: SupabaseClient };

/**
 * Gate an API route on auth + role. Usage:
 *
 *   const auth = await requireUser(['member','admin']);
 *   if ('error' in auth) return auth.error;
 *   // auth.user, auth.role, auth.sb
 */
export async function requireUser(allowed: Role[]): Promise<RequireUserResult> {
  const sb = await getServerClient();
  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) {
    return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  const { data: profile } = await sb
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || !allowed.includes(profile.role as Role)) {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { user, role: profile.role as Role, sb };
}

/**
 * Check the internal-task secret used for non-user-initiated server-to-server
 * triggers (analyze -> synthesize, enrich -> worker). Reuses CRON_SECRET to
 * avoid introducing a new env var.
 */
export function hasInternalSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add lib/auth/require-user.ts
git commit -m "feat(auth): add requireUser + hasInternalSecret helpers"
```

---

## Phase 3 — Auth UI (pages added but not linked from menu yet)

### Task 9: Add i18n keys

**Files:**
- Modify: `messages/ja.json`, `messages/en.json`

- [ ] **Step 1: Read current files to find insertion point**

```bash
head -5 messages/ja.json
head -5 messages/en.json
```

- [ ] **Step 2: Add keys to `messages/ja.json`**

Inside the top-level JSON object, add (merging with existing keys; do not duplicate `nav`):

```json
{
  "auth": {
    "login": {
      "title": "ログイン",
      "email": "メールアドレス",
      "password": "パスワード",
      "submit": "ログイン",
      "forgot": "パスワードをお忘れですか?",
      "errors": {
        "invalid": "メールまたはパスワードが正しくありません",
        "generic": "ログインに失敗しました。時間をおいて再度お試しください。"
      }
    },
    "resetPassword": {
      "requestTitle": "パスワードを再設定",
      "requestSubmit": "再設定メールを送信",
      "requestSent": "メールを送信しました。受信ボックスを確認してください。",
      "confirmTitle": "新しいパスワードを設定",
      "newPassword": "新しいパスワード",
      "confirmSubmit": "更新",
      "confirmDone": "パスワードを更新しました。ログインしてください。"
    },
    "logout": "ログアウト",
    "roleBadge": { "admin": "管理者", "member": "メンバー", "viewer": "閲覧者" }
  },
  "nav": {
    "userManagement": "ユーザー管理"
  },
  "admin": {
    "users": {
      "title": "ユーザー管理",
      "columns": { "email": "メール", "role": "ロール", "created": "作成日", "actions": "操作" },
      "delete": "削除",
      "confirmDelete": "本当に削除しますか?",
      "roles": { "admin": "管理者", "member": "メンバー", "viewer": "閲覧者" }
    }
  }
}
```

Use the Edit tool to merge (not Write — keep existing keys). If there is already a `nav` object, only add the new `userManagement` key under it.

- [ ] **Step 3: Add keys to `messages/en.json` (mirror structure)**

```json
{
  "auth": {
    "login": {
      "title": "Log in",
      "email": "Email",
      "password": "Password",
      "submit": "Log in",
      "forgot": "Forgot your password?",
      "errors": {
        "invalid": "Incorrect email or password",
        "generic": "Login failed. Please try again later."
      }
    },
    "resetPassword": {
      "requestTitle": "Reset password",
      "requestSubmit": "Send reset email",
      "requestSent": "Email sent. Please check your inbox.",
      "confirmTitle": "Set a new password",
      "newPassword": "New password",
      "confirmSubmit": "Update",
      "confirmDone": "Password updated. Please log in."
    },
    "logout": "Log out",
    "roleBadge": { "admin": "Admin", "member": "Member", "viewer": "Viewer" }
  },
  "nav": {
    "userManagement": "User management"
  },
  "admin": {
    "users": {
      "title": "User management",
      "columns": { "email": "Email", "role": "Role", "created": "Created", "actions": "Actions" },
      "delete": "Delete",
      "confirmDelete": "Are you sure you want to delete this user?",
      "roles": { "admin": "Admin", "member": "Member", "viewer": "Viewer" }
    }
  }
}
```

- [ ] **Step 4: Verify JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/ja.json','utf8'));console.log('ja ok')"
node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'));console.log('en ok')"
```

Expected: `ja ok` and `en ok`.

- [ ] **Step 5: Commit**

```bash
git add messages/ja.json messages/en.json
git commit -m "i18n(auth): add login, reset-password, admin/users keys"
```

---

### Task 10: Create /[locale]/login page

**Files:**
- Create: `app/[locale]/login/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
// app/[locale]/login/page.tsx
'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROLE_LANDING, type Role } from '@/lib/auth/route-permissions';

export default function LoginPage() {
  const t = useTranslations('auth.login');
  const locale = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { error, data } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      setErr(t('errors.invalid'));
      setLoading(false);
      return;
    }
    // Fetch role to decide landing
    const userId = data.user?.id;
    let role: Role = 'viewer';
    if (userId) {
      const { data: profile } = await sb
        .from('profiles').select('role').eq('id', userId).maybeSingle();
      if (profile?.role) role = profile.role as Role;
    }
    router.replace(`/${locale}${ROLE_LANDING[role]}`);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <Card className="w-full max-w-md p-8 space-y-4">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-sm mb-1">{t('email')}</label>
            <input
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">{t('password')}</label>
            <input
              type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoComplete="current-password"
            />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <Button type="submit" disabled={loading} className="w-full">
            {t('submit')}
          </Button>
        </form>
        <p className="text-sm text-center">
          <a href={`/${locale}/reset-password`} className="text-blue-600 hover:underline">
            {t('forgot')}
          </a>
        </p>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Manual smoke**

```bash
npm run dev
```

Open `http://localhost:3000/ja/login` in a browser. Expect the login card to render. Don't try to log in yet (no admin bootstrapped).

- [ ] **Step 4: Commit**

```bash
git add app/[locale]/login/page.tsx
git commit -m "feat(auth): add login page"
```

---

### Task 11: Create /[locale]/reset-password page

**Files:**
- Create: `app/[locale]/reset-password/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
// app/[locale]/reset-password/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Mode = 'request' | 'confirm';

export default function ResetPasswordPage() {
  const t = useTranslations('auth.resetPassword');
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>('request');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Supabase reset link drops "type=recovery" + access_token in URL hash.
    if (typeof window !== 'undefined' && window.location.hash.includes('type=recovery')) {
      setMode('confirm');
    }
  }, [params]);

  const sb = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const redirectTo = `${window.location.origin}/${locale}/reset-password`;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) { setErr(error.message); return; }
    setDone(t('requestSent'));
  }

  async function confirmReset(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const { error } = await sb.auth.updateUser({ password });
    if (error) { setErr(error.message); return; }
    setDone(t('confirmDone'));
    setTimeout(() => router.replace(`/${locale}/login`), 1500);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <Card className="w-full max-w-md p-8 space-y-4">
        <h1 className="text-xl font-bold">
          {mode === 'request' ? t('requestTitle') : t('confirmTitle')}
        </h1>
        {mode === 'request' ? (
          <form onSubmit={requestReset} className="space-y-3">
            <input
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoComplete="email"
            />
            <Button type="submit" className="w-full">{t('requestSubmit')}</Button>
          </form>
        ) : (
          <form onSubmit={confirmReset} className="space-y-3">
            <input
              type="password" required value={password} minLength={8}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoComplete="new-password"
              placeholder={t('newPassword')}
            />
            <Button type="submit" className="w-full">{t('confirmSubmit')}</Button>
          </form>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        {done && <p className="text-sm text-green-700">{done}</p>}
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Manual smoke**

Visit `http://localhost:3000/ja/reset-password`. Expect the email form to render.

- [ ] **Step 4: Commit**

```bash
git add app/[locale]/reset-password/page.tsx
git commit -m "feat(auth): add reset-password page (request + confirm)"
```

---

### Task 12: Create /api/admin/users routes

**Files:**
- Create: `app/api/admin/users/route.ts`, `app/api/admin/users/[id]/route.ts`

- [ ] **Step 1: Write the list endpoint**

```ts
// app/api/admin/users/route.ts
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/require-user';

export const maxDuration = 30;

export async function GET() {
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;

  const { data, error } = await auth.sb
    .from('profiles')
    .select('id, email, display_name, role, created_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ users: data });
}
```

- [ ] **Step 2: Write the per-id endpoint**

```ts
// app/api/admin/users/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/require-user';
import { getServiceClient } from '@/lib/supabase';
import type { Role } from '@/lib/auth/route-permissions';

const VALID: Role[] = ['admin', 'member', 'viewer'];

export const maxDuration = 30;

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;
  const { id } = await ctx.params;

  let body: { role?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const role = body.role as Role | undefined;
  if (!role || !VALID.includes(role)) {
    return NextResponse.json({ error: 'invalid role' }, { status: 400 });
  }
  if (id === auth.user.id && role !== 'admin') {
    return NextResponse.json({ error: 'cannot demote yourself' }, { status: 400 });
  }

  const { error } = await auth.sb.from('profiles').update({ role }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;
  const { id } = await ctx.params;

  if (id === auth.user.id) {
    return NextResponse.json({ error: 'cannot delete yourself' }, { status: 400 });
  }

  // auth.admin.deleteUser requires the service role
  const service = getServiceClient();
  const { error } = await service.auth.admin.deleteUser(id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // profiles row cascades via FK on delete
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/users
git commit -m "feat(auth): admin user list / role-change / delete endpoints"
```

---

### Task 13: Create /[locale]/admin/users page

**Files:**
- Create: `app/[locale]/admin/users/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
// app/[locale]/admin/users/page.tsx
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getServerClient } from '@/lib/supabase/server';
import UsersTable from './UsersTable';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  const sb = await getServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect(`/${locale}/login`);
  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profile?.role !== 'admin') redirect(`/${locale}`);

  const { data: users } = await sb
    .from('profiles')
    .select('id, email, role, created_at')
    .order('created_at', { ascending: false });

  const t = await getTranslations('admin.users');
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <UsersTable initial={users ?? []} currentUserId={user.id} />
    </div>
  );
}
```

- [ ] **Step 2: Write the table client component**

Create `app/[locale]/admin/users/UsersTable.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type Row = { id: string; email: string; role: 'admin'|'member'|'viewer'; created_at: string };

export default function UsersTable({ initial, currentUserId }: { initial: Row[]; currentUserId: string }) {
  const t = useTranslations('admin.users');
  const [rows, setRows] = useState<Row[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);

  async function changeRole(id: string, role: Row['role']) {
    setBusy(id);
    const r = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    setBusy(null);
    if (r.ok) {
      setRows((prev) => prev.map((row) => (row.id === id ? { ...row, role } : row)));
    } else {
      const j = await r.json().catch(() => ({}));
      alert((j as { error?: string }).error ?? 'failed');
    }
  }

  async function remove(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    setBusy(id);
    const r = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    setBusy(null);
    if (r.ok) setRows((prev) => prev.filter((row) => row.id !== id));
    else {
      const j = await r.json().catch(() => ({}));
      alert((j as { error?: string }).error ?? 'failed');
    }
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b">
          <th className="text-left p-2">{t('columns.email')}</th>
          <th className="text-left p-2">{t('columns.role')}</th>
          <th className="text-left p-2">{t('columns.created')}</th>
          <th className="text-right p-2">{t('columns.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b">
            <td className="p-2">{row.email}</td>
            <td className="p-2">
              <select
                value={row.role}
                onChange={(e) => changeRole(row.id, e.target.value as Row['role'])}
                disabled={busy === row.id || row.id === currentUserId}
                className="border rounded px-2 py-1"
              >
                <option value="viewer">{t('roles.viewer')}</option>
                <option value="member">{t('roles.member')}</option>
                <option value="admin">{t('roles.admin')}</option>
              </select>
              {row.id === currentUserId && <Badge className="ml-2">you</Badge>}
            </td>
            <td className="p-2">{new Date(row.created_at).toISOString().slice(0,10)}</td>
            <td className="p-2 text-right">
              <Button
                variant="outline" size="sm"
                onClick={() => remove(row.id)}
                disabled={busy === row.id || row.id === currentUserId}
              >
                {t('delete')}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add "app/[locale]/admin"
git commit -m "feat(auth): admin user management page"
```

---

## Phase 4 — Bootstrap first admin (manual, post-deploy of Phases 1-3)

### Task 14: Configure Supabase Dashboard (one-time)

- [ ] **Step 1: Open Supabase Studio → Authentication → Providers → Email**

- [ ] **Step 2: Enable Email provider, toggle "Confirm email" OFF**

(Invites are trusted; admin manually issues them.)

- [ ] **Step 3: Authentication → URL Configuration**

- Site URL: production deployment URL (e.g. `https://mediaworks.flowos.work`).
- Additional Redirect URLs: include `http://localhost:3000` and `http://localhost:3000/*`.

- [ ] **Step 4: Authentication → Email Templates**

Localize the **Invite user** and **Reset Password** templates to Japanese (primary) with an English fallback note if desired. Keep Supabase variables `{{ .ConfirmationURL }}`.

- [ ] **Step 5: Authentication → Settings**

Toggle **"Allow new users to sign up"** OFF.

- [ ] **Step 6: Note completion**

Record date completed and the production Site URL value in a private ops doc. (No commit.)

---

### Task 15: Bootstrap first admin

- [ ] **Step 1: Invite admin email**

Supabase Studio → Authentication → Users → "Invite user" → enter `jp@flowos.work`.

- [ ] **Step 2: Accept invite, set password**

Open the invite mail, click the link, set a password. Confirm you land on the production app at the configured Site URL.

- [ ] **Step 3: Verify `profiles` row was created**

```sql
select id, email, role, created_at from public.profiles
  where email='jp@flowos.work';
```

Expected: 1 row, `role='viewer'`.

- [ ] **Step 4: Promote to admin**

```sql
update public.profiles set role='admin' where email='jp@flowos.work';
```

Expected: `UPDATE 1`.

- [ ] **Step 5: Log in to the app at `/ja/login`**

Confirm you can sign in. Visit `/ja/admin/users` directly — should render the table with at least your own row.

(No commit — this is operational.)

---

## Phase 5 — Enforcement gate (the risk step)

### Task 16: Convert Navbar to Server Component, role-aware

**Files:**
- Modify: `components/Navbar.tsx`

- [ ] **Step 1: Read current Navbar to confirm shape**

```bash
cat components/Navbar.tsx
```

- [ ] **Step 2: Replace with role-aware Server Component**

```tsx
// components/Navbar.tsx
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import LanguageSwitcher from './LanguageSwitcher';
import UserMenu from './UserMenu';
import { BarChart3, Calendar, Users } from 'lucide-react';
import { getServerClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/auth/route-permissions';

export default async function Navbar() {
  const t = await getTranslations('nav');
  const locale = await getLocale();

  const sb = await getServerClient();
  const { data: { user } } = await sb.auth.getUser();
  let role: Role | null = null;
  if (user) {
    const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
    role = (profile?.role ?? null) as Role | null;
  }

  const isViewer = role === 'viewer';
  const isAdmin = role === 'admin';
  const homeHref = isViewer ? `/${locale}/analytics/products` : `/${locale}`;

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href={homeHref} className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <BarChart3 size={18} className="text-white" />
            </div>
            <span className="text-lg font-bold text-gray-900">MediaWorks</span>
          </Link>
          <div className="flex items-center gap-4">
            {role && !isViewer && (
              <>
                <Link href={`/${locale}`} className="text-sm text-gray-600 hover:text-gray-900 font-medium">{t('home')}</Link>
                <Link href={`/${locale}/broadcasts`} className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1">
                  <Calendar size={14} />{t('broadcasts')}
                </Link>
                <Link href={`/${locale}/analytics`} className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1">
                  <BarChart3 size={14} />{t('analytics')}
                </Link>
              </>
            )}
            {isViewer && (
              <Link href={`/${locale}/analytics/products`} className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1">
                <BarChart3 size={14} />{t('analytics')}
              </Link>
            )}
            {isAdmin && (
              <Link href={`/${locale}/admin/users`} className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1">
                <Users size={14} />{t('userManagement')}
              </Link>
            )}
            <LanguageSwitcher />
            <UserMenu email={user?.email ?? null} role={role} locale={locale} />
          </div>
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 3: Add `components/UserMenu.tsx`**

```tsx
// components/UserMenu.tsx
'use client';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Role } from '@/lib/auth/route-permissions';

export default function UserMenu({ email, role, locale }: { email: string | null; role: Role | null; locale: string }) {
  const router = useRouter();
  const t = useTranslations('auth');

  if (!email || !role) {
    return (
      <a href={`/${locale}/login`} className="text-sm font-medium text-blue-600 hover:underline">
        {t('login.submit')}
      </a>
    );
  }

  async function logout() {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    await sb.auth.signOut();
    router.replace(`/${locale}/login`);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="text-xs">{t(`roleBadge.${role}`)}</Badge>
      <span className="text-sm text-gray-700 hidden sm:inline">{email}</span>
      <Button variant="ghost" size="sm" onClick={logout}>{t('logout')}</Button>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add components/Navbar.tsx components/UserMenu.tsx
git commit -m "feat(auth): role-aware Navbar + UserMenu"
```

---

### Task 17: Update proxy.ts — combine next-intl + auth

**Files:**
- Modify: `proxy.ts`

- [ ] **Step 1: Replace `proxy.ts`**

```ts
// proxy.ts
import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { isViewerAllowedPath, ROLE_LANDING } from '@/lib/auth/route-permissions';

const intl = createIntlMiddleware({
  locales: ['en', 'ja'],
  defaultLocale: 'ja',
  localePrefix: 'always',
});

const PUBLIC_SUFFIXES = [/\/login$/, /\/reset-password$/];

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip API + Next internals + static — matcher below already excludes these,
  // but be defensive in case a future matcher edit slips.
  if (pathname.startsWith('/api') || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  const { response, user, role } = await updateSession(req);
  const isPublic = PUBLIC_SUFFIXES.some((re) => re.test(pathname));

  if (isPublic) return intl(req);

  if (!user) {
    const loginUrl = new URL(`/ja/login`, req.url);
    return NextResponse.redirect(loginUrl);
  }

  if (role === 'viewer' && !isViewerAllowedPath(pathname)) {
    const dest = new URL(`/ja${ROLE_LANDING.viewer}`, req.url);
    return NextResponse.redirect(dest);
  }

  // Defer to next-intl for the normal routed response, then merge cookies from session refresh.
  const intlRes = intl(req);
  for (const c of response.cookies.getAll()) {
    const { name, value, ...options } = c;
    intlRes.cookies.set(name, value, options);
  }
  return intlRes;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|\\.well-known/workflow|.*\\..*).*)'],
};
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Manual smoke (unauth)**

```bash
npm run dev
```

In an incognito window, visit `http://localhost:3000/ja` — expect redirect to `/ja/login`.
Visit `http://localhost:3000/ja/login` directly — expect the login form (no redirect loop).

- [ ] **Step 4: Manual smoke (admin)**

Log in as the bootstrapped admin. Confirm:
- `/ja` renders home.
- `/ja/analytics/products` renders.
- `/ja/admin/users` renders.

- [ ] **Step 5: Commit**

```bash
git add proxy.ts
git commit -m "feat(auth): proxy combines next-intl + session enforcement"
```

---

### Task 18: Gate viewer-allowed API routes (analytics/products)

**Files:**
- Modify: `app/api/analytics/products/route.ts`, `app/api/analytics/products/[code]/route.ts`, `app/api/analytics/products/[code]/images/route.ts`

- [ ] **Step 1: Add `requireUser(['admin','member','viewer'])` to `app/api/analytics/products/route.ts`**

At the top of the GET handler (after extracting params), insert:

```ts
import { requireUser } from '@/lib/auth/require-user';
// ...
export async function GET(req: NextRequest) {
  const auth = await requireUser(['admin','member','viewer']);
  if ('error' in auth) return auth.error;
  // existing body, but swap getServiceClient() -> auth.sb so RLS applies
  // ...
}
```

Replace the internal `supabase` / `getServiceClient()` usage with `auth.sb`.

- [ ] **Step 2: Repeat for `app/api/analytics/products/[code]/route.ts`**

Same pattern — `requireUser(['admin','member','viewer'])`, swap supabase client to `auth.sb`.

- [ ] **Step 3: Repeat for `app/api/analytics/products/[code]/images/route.ts`**

Same pattern.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Manual smoke**

With the dev server running and logged in as admin:

```bash
# Should succeed
curl -sS -b "<paste sb-auth cookies from browser DevTools>" \
  http://localhost:3000/api/analytics/products | head -c 200
```

Without cookies:

```bash
curl -sS http://localhost:3000/api/analytics/products
```

Expected: `{"error":"unauthorized"}` with HTTP 401.

- [ ] **Step 6: Commit**

```bash
git add app/api/analytics/products
git commit -m "feat(auth): require auth on analytics/products endpoints"
```

---

### Task 19: Gate member/admin user-facing API routes

**Files (all `app/api/*` except cron, admin, viewer-allowed, internal-worker):**

- `app/api/analyze/route.ts`
- `app/api/products/route.ts`
- `app/api/products/[id]/route.ts`
- `app/api/products/upload-taicho/route.ts`
- `app/api/upload/route.ts`
- `app/api/recommend/route.ts`
- `app/api/analytics/overview/route.ts`
- `app/api/analytics/trends/route.ts`
- `app/api/analytics/gallery/route.ts`
- `app/api/analytics/expansion/route.ts`
- `app/api/analytics/md-strategy/route.ts`
- `app/api/analytics/md-strategy/[id]/route.ts`
- `app/api/analytics/md-strategy/[id]/rediscover/route.ts`
- `app/api/analytics/md-strategy/run/[runId]/status/route.ts`
- `app/api/analytics/md-strategy/run/[runId]/stream/route.ts`
- `app/api/analytics/live-commerce/route.ts`
- `app/api/analytics/live-commerce/[id]/route.ts`
- `app/api/analytics/live-commerce/[id]/rediscover/route.ts`
- `app/api/analytics/live-commerce/run/[runId]/status/route.ts`
- `app/api/analytics/live-commerce/run/[runId]/stream/route.ts`
- `app/api/analytics/discovery/route.ts`
- `app/api/analytics/discovery/analyze/route.ts`
- `app/api/analytics/discovery/[sessionId]/route.ts`
- `app/api/discovery/history/route.ts`
- `app/api/discovery/insights/route.ts`
- `app/api/discovery/today/route.ts`
- `app/api/discovery/selections/route.ts`
- `app/api/discovery/sessions/route.ts`
- `app/api/discovery/sessions/[id]/route.ts`
- `app/api/discovery/enrich/[productId]/route.ts`
- `app/api/broadcasts/route.ts`

- [ ] **Step 1: For each file, add `requireUser(['member','admin'])` at the top of each exported HTTP method**

Edit pattern (apply to every handler in the list above):

```ts
import { requireUser } from '@/lib/auth/require-user';
// at top of GET/POST/etc:
const auth = await requireUser(['member','admin']);
if ('error' in auth) return auth.error;
// continue using existing supabase client OR switch to auth.sb where convenient
```

Note: many existing handlers use `getServiceClient()` for queries that span team-wide data. Leave the service client in place where it's already querying shared resources — RLS gating happens at requireUser. Only swap to `auth.sb` if you explicitly want RLS-checked reads (e.g. routes that should not return data outside the user's permission scope). For the routes in this list, keeping `getServiceClient()` is correct because they all target member/admin-only data anyway.

- [ ] **Step 2: Typecheck after each batch of ~5 files**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Manual smoke (one representative call)**

Without session:

```bash
curl -sS http://localhost:3000/api/analytics/overview
```

Expected: `{"error":"unauthorized"}` 401.

With member/admin session cookies: expect 200 + data.

- [ ] **Step 4: Commit**

```bash
git add app/api
git commit -m "feat(auth): require member/admin on all user-facing API routes"
```

---

### Task 20: Update /api/discovery/feedback to attribute user_id

**Files:**
- Modify: `app/api/discovery/feedback/route.ts`

- [ ] **Step 1: Read current implementation**

```bash
cat app/api/discovery/feedback/route.ts
```

- [ ] **Step 2: Replace contents**

```ts
// app/api/discovery/feedback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";

export const maxDuration = 10;

type Action = "sourced" | "interested" | "rejected" | "duplicate";
const VALID_ACTIONS: Action[] = ["sourced", "interested", "rejected", "duplicate"];

const FIXED_REASONS = [
  "価格帯不適合",
  "カテゴリ過飽和",
  "既に放送中",
  "品質懸念",
  "その他",
];

function isValidReason(reason: string | undefined): boolean {
  if (!reason) return false;
  if (FIXED_REASONS.includes(reason)) return true;
  return reason.startsWith("その他") && reason.length <= 200;
}

interface FeedbackBody {
  productId: string;
  action: Action;
  reason?: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(['member','admin']);
  if ('error' in auth) return auth.error;

  let body: FeedbackBody;
  try { body = (await req.json()) as FeedbackBody; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }

  if (!body.productId) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }
  if (!VALID_ACTIONS.includes(body.action)) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  if (body.action === "rejected" && !isValidReason(body.reason)) {
    return NextResponse.json(
      { error: 'reason required — must be one of fixed 5 values or start with "その他" for custom' },
      { status: 400 },
    );
  }

  // Use service client to update team-shared discovered_products.user_action,
  // and insert into product_feedback with auth.user.id attribution.
  const sb = getServiceClient();

  const { data: product, error: prodErr } = await sb
    .from("discovered_products")
    .select("id, user_action")
    .eq("id", body.productId)
    .maybeSingle();

  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 });
  if (!product) return NextResponse.json({ error: "product not found" }, { status: 404 });

  const isToggleOff = product.user_action === body.action;
  const now = new Date().toISOString();

  if (isToggleOff) {
    const { error: updErr } = await sb
      .from("discovered_products")
      .update({ user_action: null, action_reason: null, action_at: null })
      .eq("id", body.productId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, action: "toggled_off", user_action: null });
  }

  const reason = body.action === "rejected" ? body.reason ?? null : null;

  const [insertRes, updRes] = await Promise.all([
    sb.from("product_feedback").insert({
      discovered_product_id: body.productId,
      action: body.action,
      reason,
      user_id: auth.user.id,
    }),
    sb
      .from("discovered_products")
      .update({ user_action: body.action, action_reason: reason, action_at: now })
      .eq("id", body.productId),
  ]);

  if (insertRes.error) {
    console.warn(`[feedback] insert failed:`, insertRes.error.message);
  }
  if (updRes.error) {
    return NextResponse.json({ error: updRes.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, action: "set", user_action: body.action });
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Manual smoke**

Log in as member. Click a feedback button in the UI. Then verify in Supabase Studio:

```sql
select id, discovered_product_id, action, user_id, created_at
from public.product_feedback
order by created_at desc limit 1;
```

Expected: `user_id` matches your `auth.uid()`.

- [ ] **Step 5: Commit**

```bash
git add app/api/discovery/feedback/route.ts
git commit -m "feat(auth): attribute feedback to user_id"
```

---

### Task 21: Gate admin-only and internal-trigger routes

**Files:**
- Modify: `app/api/discovery/manual-trigger/route.ts` (admin-only)
- Modify: `app/api/broadcasts/refresh/route.ts` (admin OR CRON_SECRET)
- Modify: `app/api/analyze/synthesize/route.ts` (CRON_SECRET only — internal)
- Modify: `app/api/discovery/enrich/[productId]/worker/route.ts` (CRON_SECRET only — internal)
- Modify: `app/api/analyze/route.ts` (caller — add Authorization header on internal fetch)

- [ ] **Step 1: `app/api/discovery/manual-trigger/route.ts` — admin only**

At the top of the POST handler:

```ts
import { requireUser } from '@/lib/auth/require-user';

const auth = await requireUser(['admin']);
if ('error' in auth) return auth.error;
```

- [ ] **Step 2: `app/api/broadcasts/refresh/route.ts` — admin OR CRON_SECRET**

Replace `verifyAuth` body with:

```ts
import { requireUser } from '@/lib/auth/require-user';
import { hasInternalSecret } from '@/lib/auth/require-user';

async function verifyAdminOrCron(req: NextRequest): Promise<NextResponse | null> {
  if (hasInternalSecret(req)) return null;
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;
  return null;
}

// In POST(req):
const denied = await verifyAdminOrCron(req);
if (denied) return denied;
// existing body
```

Remove the old `verifyAuth` helper.

- [ ] **Step 3: `app/api/analyze/synthesize/route.ts` — CRON_SECRET only**

At the top of POST:

```ts
import { hasInternalSecret } from '@/lib/auth/require-user';

if (!hasInternalSecret(request)) {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}
```

- [ ] **Step 4: `app/api/discovery/enrich/[productId]/worker/route.ts` — standardize on hasInternalSecret**

The worker already has an inline `CRON_SECRET` check (lines ~15–21). Replace it with the shared helper for consistency:

```ts
import { hasInternalSecret } from '@/lib/auth/require-user';

// at the top of POST(req, ctx):
if (!hasInternalSecret(req)) {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}
```

Delete the old inline `const secret = process.env.CRON_SECRET; if (secret) { ... }` block.

- [ ] **Step 5: `app/api/analyze/route.ts` — add header to the internal fetch**

Find the `fetch(\`${baseUrl}/api/analyze/synthesize\`...)` call and add the header:

```ts
fetch(`${baseUrl}/api/analyze/synthesize`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.CRON_SECRET}`,
  },
  body: JSON.stringify({ productId }),
}).catch((err) => {
  console.error(`[${productId}] Failed to trigger synthesize:`, err);
});
```

Also at the top of `POST(request)` add the standard user gate:

```ts
const auth = await requireUser(['member','admin']);
if ('error' in auth) return auth.error;
```

(This puts /api/analyze on the user-gated list and /api/analyze/synthesize on the internal list — they were not in the bulk list in Task 19 because of this dependency.)

- [ ] **Step 6: For `app/api/discovery/enrich/[productId]/route.ts` — verify only**

This file gets `requireUser(['member','admin'])` from Task 19 (it's in that list). The internal fetch to `/worker` (lines ~72–85) already sends `Authorization: Bearer ${CRON_SECRET}` — confirm by grepping `Authorization` in that file. No edit needed.

- [ ] **Step 7: Confirm CRON_SECRET is set in env**

```bash
grep -E '^CRON_SECRET=' .env.local || echo 'MISSING — set CRON_SECRET in .env.local and on Vercel'
```

If missing locally, set it (matching the Vercel project's value) before testing.

- [ ] **Step 8: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 9: Manual smoke**

```bash
# synthesize without secret -> 401
curl -sS -X POST http://localhost:3000/api/analyze/synthesize \
  -H "Content-Type: application/json" -d '{"productId":"x"}'
# expect: {"error":"unauthorized"}

# synthesize with secret -> 400 (productId not found is fine; gate passed)
curl -sS -X POST http://localhost:3000/api/analyze/synthesize \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -d '{"productId":"nonexistent"}'
# expect: {"error":"...not found..."} or similar — but NOT "unauthorized"
```

- [ ] **Step 10: Commit**

```bash
git add app/api/discovery/manual-trigger \
        app/api/broadcasts/refresh \
        app/api/analyze \
        app/api/discovery/enrich
git commit -m "feat(auth): gate admin-only routes; protect internal-trigger routes"
```

---

### Task 22: Migration 04 — Tighten RLS to role-based policies

**Files:**
- Create: `supabase/migrations/2026-05-13_auth_rls_tight.sql`

- [ ] **Step 1: Write the SQL migration**

```sql
-- 2026-05-13_auth_rls_tight.sql
-- Drops loose policies from migration 02 and installs role-based ones.

-- Helper to write policies concisely
do $$
declare t text;
begin
  -- Drop loose policies first
  foreach t in array array[
    'product_details','product_images','sales_weekly','sales_weekly_totals',
    'products','product_files','research_results',
    'discovered_products','discovery_runs','discovery_sessions','discovery_product_analyses',
    'learning_state','learning_insights','broadcasts','qvc_products',
    'md_strategies','live_commerce_strategies','product_feedback','profiles'
  ] loop
    execute format('drop policy if exists "loose_all" on public.%I', t);
  end loop;
end $$;

-- Group A — TXD (viewer-readable)
do $$
declare t text;
begin
  foreach t in array array[
    'product_details','product_images','sales_weekly','sales_weekly_totals'
  ] loop
    execute format('create policy "auth_read" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "member_write" on public.%I for insert to authenticated with check (public.current_user_role() in (''member'',''admin''))', t);
    execute format('create policy "member_update" on public.%I for update to authenticated using (public.current_user_role() in (''member'',''admin'')) with check (public.current_user_role() in (''member'',''admin''))', t);
    execute format('create policy "admin_delete" on public.%I for delete to authenticated using (public.current_user_role() = ''admin'')', t);
  end loop;
end $$;

-- Group B — Internal
do $$
declare t text;
begin
  foreach t in array array[
    'products','product_files','research_results',
    'discovered_products','discovery_runs','discovery_sessions','discovery_product_analyses',
    'learning_state','learning_insights','broadcasts','qvc_products',
    'md_strategies','live_commerce_strategies'
  ] loop
    execute format('create policy "member_read" on public.%I for select to authenticated using (public.current_user_role() in (''member'',''admin''))', t);
    execute format('create policy "member_all" on public.%I for all to authenticated using (public.current_user_role() in (''member'',''admin'')) with check (public.current_user_role() in (''member'',''admin''))', t);
  end loop;
end $$;

-- Group C — product_feedback
create policy "feedback_read" on public.product_feedback
  for select to authenticated
  using (public.current_user_role() in ('member','admin'));

create policy "feedback_insert_own" on public.product_feedback
  for insert to authenticated
  with check (
    public.current_user_role() in ('member','admin')
    and user_id = auth.uid()
  );

create policy "feedback_delete_own_or_admin" on public.product_feedback
  for delete to authenticated
  using (user_id = auth.uid() or public.current_user_role() = 'admin');

-- Group D — profiles
create policy "profiles_self_read" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_user_role() = 'admin');

create policy "profiles_self_update" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles_admin_all" on public.profiles
  for all to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');
```

- [ ] **Step 2: Apply migration**

Studio → SQL Editor → run.

- [ ] **Step 3: Verify policy counts**

```sql
select tablename, count(*) as policies
from pg_policies
where schemaname='public'
group by tablename
order by tablename;
```

Expected: each Group A table has 4 policies, each Group B has 2, `product_feedback` has 3, `profiles` has 3.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-13_auth_rls_tight.sql
git commit -m "feat(auth): tighten RLS to role-based policies"
```

---

### Task 23: Verify view security_invoker

**Files:**
- Create: `supabase/migrations/2026-05-13_auth_view_security.sql` (only if needed)

- [ ] **Step 1: Inspect view definitions**

```sql
select table_name,
       (select option_value
        from information_schema.view_table_usage v
        where v.view_name = c.table_name and v.view_schema='public'
        limit 1) as has_underlying,
       c.security_type
from information_schema.views c
where c.table_schema='public'
  and c.table_name in ('product_summaries','monthly_summaries','category_summaries','annual_summaries');
```

(`security_type` may not exist on all Postgres versions; alternative — read the view definition.)

A more reliable check — list options on each view:

```sql
select relname,
       (select option_value
        from pg_options_to_table(reloptions)
        where option_name='security_invoker') as security_invoker
from pg_class
where relkind='v'
  and relnamespace=(select oid from pg_namespace where nspname='public')
  and relname in ('product_summaries','monthly_summaries','category_summaries','annual_summaries');
```

- [ ] **Step 2: If any view lacks `security_invoker=on`, write the migration**

```sql
-- 2026-05-13_auth_view_security.sql
alter view public.product_summaries  set (security_invoker = on);
alter view public.monthly_summaries  set (security_invoker = on);
alter view public.category_summaries set (security_invoker = on);
alter view public.annual_summaries   set (security_invoker = on);
```

Apply via Studio → SQL Editor.

- [ ] **Step 3: Re-verify**

Re-run the query from Step 1. Expected: every view shows `security_invoker = on`.

- [ ] **Step 4: Commit (only if migration was created)**

```bash
git add supabase/migrations/2026-05-13_auth_view_security.sql
git commit -m "feat(auth): ensure analytics views run with caller's RLS"
```

If no migration was needed, document in `docs/superpowers/specs/2026-05-13-auth-and-tiered-access-design.md` that views already use security_invoker (add a one-line note in the "Items the implementation plan must verify" section).

---

### Task 24: Update CLAUDE.md with auth convention

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read the existing file to find an insertion point**

```bash
cat CLAUDE.md
```

- [ ] **Step 2: Insert a new section "Auth usage" under "Key Conventions"**

Add this paragraph (use the Edit tool — keep all other content):

```markdown
- **Auth (added 2026-05-13)**: Code reached from a user request must use
  `lib/supabase/server.ts::getServerClient()` and gate with
  `lib/auth/require-user.ts::requireUser([roles])`. `getServiceClient()` is
  reserved for cron, workflow steps, and other non-user-initiated paths.
  Calling `getServiceClient()` from a user-facing route bypasses RLS and
  risks data leakage. Internal server-to-server calls (e.g. `/api/analyze` ->
  `/api/analyze/synthesize`) authenticate with `Bearer ${CRON_SECRET}` via
  `hasInternalSecret()`. RLS is the last line of defence — if you add a new
  table, also add a Group B (member/admin) policy at minimum.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(auth): document auth usage convention"
```

---

### Task 25: End-to-end manual verification

This is the gate before merging Phase 5. Run all scenarios; record results.

- [ ] **Scenario 1 — Unauth redirect**

```bash
# Incognito browser
visit http://localhost:3000/ja
```
Expected: redirected to `/ja/login`. The login form renders.

- [ ] **Scenario 2 — Viewer scope**

- Promote a second invited user to `viewer` via `/ja/admin/users` (or `update profiles set role='viewer' where email='<test>'`).
- Log in as that user (incognito).
- Expected:
  - Lands on `/ja/analytics/products` after login.
  - Navbar shows only the "Analytics" link, role badge "閲覧者".
  - Visiting `/ja/broadcasts` -> redirected to `/ja/analytics/products`.
  - Visiting `/ja/admin/users` -> redirected.

- [ ] **Scenario 3 — Viewer feedback blocked**

```bash
curl -sS -X POST http://localhost:3000/api/discovery/feedback \
  -H "Content-Type: application/json" \
  -b "<viewer cookies>" \
  -d '{"productId":"<any-id>","action":"sourced"}'
```
Expected: `{"error":"forbidden"}` with HTTP 403.

- [ ] **Scenario 4 — Member feedback writes user_id**

- Log in as member.
- Click a feedback button in `/ja/analytics/discovery/home` (or wherever the buttons live).
- Check Supabase:
```sql
select user_id, action, created_at from public.product_feedback
order by created_at desc limit 3;
```
Expected: top row has `user_id` matching the member's auth.uid().

- [ ] **Scenario 5 — Admin user management**

- Log in as admin.
- Open `/ja/admin/users`. Confirm table shows all users with role selects.
- Change a user's role from `viewer` to `member`. Confirm the row updates.
- Confirm the "you" badge appears on your own row and that the role select for it is disabled.

- [ ] **Scenario 6 — Cron endpoint unaffected**

```bash
curl -sS -X POST http://localhost:3000/api/cron/daily-broadcasts \
  -H "Authorization: Bearer $CRON_SECRET"
```
Expected: HTTP 200 (or whatever the cron normally returns). Session-less call succeeds because cron uses CRON_SECRET, not user auth.

- [ ] **Scenario 7 — Internal synthesize gate**

```bash
# Without secret -> 401
curl -sS -X POST http://localhost:3000/api/analyze/synthesize \
  -H "Content-Type: application/json" -d '{"productId":"x"}'

# With secret -> passes gate (will 404 on a fake productId, that's fine)
curl -sS -X POST http://localhost:3000/api/analyze/synthesize \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -d '{"productId":"fake"}'
```

- [ ] **All passed?** Commit the recorded scenarios as part of the PR description / change log.

---

### Task 26: Push branch and open PR

- [ ] **Step 1: Confirm everything committed**

```bash
git status
git log --oneline origin/main..HEAD
```

Expected: clean working tree, list of commits matches the phases above.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin worktree-feat-auth-tiered-access:feat/auth-tiered-access
```

(Renames the branch on remote to drop the `worktree-` prefix — cleaner for the PR.)

- [ ] **Step 3: Open PR via gh CLI**

```bash
gh pr create --title "feat(auth): invite-only auth + admin/member/viewer access control" --body "$(cat <<'EOF'
## Summary
- Adds Supabase-Auth-based authentication via `@supabase/ssr`, gated by middleware + API `requireUser` + Postgres RLS.
- Three roles: `admin`, `member`, `viewer`. Viewer can only read the TXD product analytics surface.
- `product_feedback.user_id` records who took each action, enabling future learning weights.
- Source spec: `docs/superpowers/specs/2026-05-13-auth-and-tiered-access-design.md`.
- Plan: `docs/superpowers/plans/2026-05-13-auth-and-tiered-access.md`.

## Rollout (already executed against staging)
1–3. Schema + loose RLS + auth library + auth pages (no behavior change).
4. Bootstrap first admin via Supabase Studio + SQL.
5. **This PR's risk gate** — proxy/Navbar/requireUser/RLS-tighten enables enforcement.

## Test plan
- [ ] Unauth `/ja` -> redirects to `/ja/login`
- [ ] Viewer login lands on `/ja/analytics/products`; other pages redirect
- [ ] Viewer `POST /api/discovery/feedback` -> 403
- [ ] Member feedback writes `user_id`
- [ ] Admin user-management page promotes/demotes/deletes
- [ ] Cron endpoint with `Bearer ${CRON_SECRET}` still works
- [ ] `/api/analyze/synthesize` requires `Bearer ${CRON_SECRET}` when called without a user session

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Note the PR URL for the user**

---

## Phase 6 — Post-merge (manual, operational)

### Task 27: Invite remaining members and clients

- [ ] **Step 1: Per remaining internal team member**

Studio → Authentication → Users → Invite. After they set their password, set role:

```sql
update public.profiles set role='member' where email='<their-email>';
```

- [ ] **Step 2: Per external client**

Same invite flow. Leave `role='viewer'` (the default).

- [ ] **Step 3: Communicate access**

Send a short note to each invitee with the login URL, role, and which sections they can see.

---

## Out-of-band cleanup

- After this branch is merged, the older spec file at the original
  working tree path (`E:\Github\mediaworks\docs\superpowers\specs\2026-05-13-auth-and-tiered-access-design.md`,
  untracked) becomes a duplicate. Delete it from the original tree manually.

---

## Risk gate and rollback

Phase 5 (Tasks 16–25) is the only step that changes user-visible behaviour. If
production behaves unexpectedly:

- **Quick revert (code):** `git revert <task-17-commit>` to disable
  `proxy.ts` enforcement. Pages become accessible again without sessions.
  Data is untouched.
- **RLS revert (DB):** run the SQL from Task 2 again to recreate the
  `loose_all` policies (and drop the tight policies created in Task 22).
  Anon access restored.
