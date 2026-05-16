# Auth & Tiered Access Design

**Date:** 2026-05-13
**Status:** Draft — pending implementation plan
**Owner:** jp@flowos.work

## Goal

Add invite-only authentication and role-based access control to the MediaWorks
home shopping research platform so that:

1. Anonymous public access is removed.
2. Three roles — `admin`, `member`, `viewer` — gate what each user can see
   and do.
3. Feedback (`sourced` / `interested` / `rejected` / `duplicate`) is attributed
   to the user who created it so future learning loops can weight signals by
   contributor.

## Non-goals

- Self-signup (admin invites only).
- Per-resource (per-product / per-broadcast) sharing — out of scope. All access
  is decided at the role level.
- In-app invite UI (Phase 2). Admin uses Supabase Studio for invites.
- A test framework or automated test suite. Manual verification only.

## User population & tier model

- **admin** — internal owners. Full access + can invite, promote, delete users.
- **member** — internal team (MD team, analysts). Full access to all product /
  discovery / strategy / broadcast features and feedback. Cannot manage users.
- **viewer** — external clients. Can only read the existing TXD product
  analytics list (`/[locale]/analytics/products` and its details), and cannot
  submit feedback or trigger any action.

The default for a newly created `auth.users` row is `viewer`. Admins promote
manually.

## Architecture

```
[Browser]
  |
  | httpOnly cookie (sb-access-token, sb-refresh-token)
  v
[proxy.ts]  - next-intl routing (unchanged)
            - @supabase/ssr session refresh (NEW)
            - unauth + protected route -> /login
            - viewer + disallowed route -> /analytics/products
  |
  v
[Server Component / API Route]
  - requireUser(allowedRoles) gate
  - getServerClient() for user-facing data (RLS applies)
  - getServiceClient() for cron / background only (RLS bypassed)
  |
  v
[Postgres + RLS]
  - SELECT/INSERT/UPDATE/DELETE policies per table group
  - service role bypasses RLS
```

Three layers of defence: middleware (UX), API `requireUser` (logical), RLS
(last line — even if an API forgets to gate, the database refuses).

New dependency: `@supabase/ssr` (single package).

## Data model

### New: `profiles`

```sql
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'viewer'
    check (role in ('admin','member','viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'viewer');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

### Modified: `product_feedback`

```sql
alter table public.product_feedback
  add column user_id uuid references public.profiles(id) on delete set null;
create index on public.product_feedback (user_id, created_at desc);
```

Existing rows keep `user_id = null` (pre-auth seed). `discovered_products.user_action`
stays as-is — it represents the team's representative state.

No other table gets a `user_id` column. Team-shared resources rely on RLS for
viewer exclusion.

## Authentication flows

### Login page — `/[locale]/login`

- Email + password form (no signup).
- Reset-password link.
- On success, redirect by role:
  - `viewer` -> `/[locale]/analytics/products`
  - `member` / `admin` -> `/[locale]`

### Reset password — `/[locale]/reset-password`

- Two states: request (email) and confirm (token in URL).
- Uses Supabase `resetPasswordForEmail` and `updateUser({ password })`.

### Invite flow (Phase 1)

1. Admin opens Supabase Studio -> Authentication -> Invite user.
2. User clicks invite link, sets password.
3. `auth.users` row created -> trigger inserts `profiles` row with `role='viewer'`.
4. Admin opens `/[locale]/admin/users` and promotes if needed.

### Session

- `@supabase/ssr` cookie-based, httpOnly + secure.
- Access token: 1h. Refresh token: 30d. Middleware refreshes on each request.

## Permission matrix

### Pages

| Path | admin | member | viewer |
|---|:---:|:---:|:---:|
| `/[locale]` (home) | yes | yes | redirect to `/analytics/products` |
| `/[locale]/products/[id]` (uploaded report) | yes | yes | no |
| `/[locale]/analytics` (and `/overview`, `/discovery/*`, `/strategy/*`) | yes | yes | no |
| `/[locale]/analytics/products` (TXD list) | yes | yes | **yes** |
| `/[locale]/analytics/products/[code]` (TXD detail) | yes | yes | **yes** |
| `/[locale]/broadcasts` | yes | yes | no |
| `/[locale]/gallery` | yes | yes | no |
| `/[locale]/admin/users` (new) | yes | no | no |
| `/[locale]/login`, `/reset-password` | unauth-only | unauth-only | unauth-only |

Direct entry to a disallowed path -> middleware redirects.

### APIs

| Pattern | admin | member | viewer | Notes |
|---|:---:|:---:|:---:|---|
| `/api/analytics/products/**` (GET) | yes | yes | **yes** | viewer read |
| `/api/analytics/gallery`, `/trends`, `/overview` | yes | yes | no | |
| `/api/analytics/md-strategy/**` | yes | yes | no | |
| `/api/analytics/live-commerce/**` | yes | yes | no | |
| `/api/analytics/expansion`, `/analytics/discovery/**` | yes | yes | no | |
| `/api/discovery/feedback` (POST) | yes | yes | no | user_id auto-attached |
| `/api/discovery/**` (others) | yes | yes | no | |
| `/api/broadcasts`, `/api/broadcasts/refresh` | yes | yes | no | refresh keeps CRON_SECRET |
| `/api/products/**`, `/api/upload`, `/api/products/upload-taicho` | yes | yes | no | |
| `/api/analyze`, `/api/analyze/synthesize`, `/api/recommend` | yes | yes | no | |
| `/api/cron/**` | header-only | header-only | header-only | unchanged Bearer ${CRON_SECRET} |
| `/api/admin/users` (new) | yes | no | no | |

Every protected API route starts with `requireUser([roles])` from
`lib/auth/require-user.ts`. The matrix is encoded as a constant in
`lib/auth/route-permissions.ts`.

## RLS policies

### Helper

```sql
create or replace function public.current_user_role() returns text
  language sql security definer stable set search_path = public as $$
    select role from public.profiles where id = auth.uid()
$$;
```

### Table groups

| Group | Tables / Views | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|---|
| **A. TXD (viewer-readable)** | `product_details`, `product_images`, `sales_weekly`, `sales_weekly_totals`, `product_summaries`, `monthly_summaries` (plus any other view queried by `/api/analytics/products/**` — implementation plan must enumerate from current schema) | all authenticated | member / admin |
| **B. Internal resources** | `products`, `product_files`, `research_results`, `discovered_products`, `broadcasts`, `qvc_products`, `md_strategies`, `live_commerce_strategies`, `discovery_sessions`, other analytics tables | member / admin | member / admin |
| **C. Feedback** | `product_feedback` (append-only in current code; DELETE policy is future-proofing) | member / admin | member / admin; INSERT must satisfy `user_id = auth.uid()` |
| **D. Users** | `profiles` | self + admin | admin only (role change blocked by trigger for non-admin) |

Views (`product_summaries`, `monthly_summaries`) inherit row visibility from
their underlying tables only when defined with `security_invoker = true`. The
implementation plan must verify each viewer-readable view's definition and
either set `security_invoker = true` or attach explicit grants.

### Example — Group A (`product_details`)

```sql
alter table public.product_details enable row level security;

create policy "auth read" on public.product_details
  for select to authenticated using (true);

create policy "member write" on public.product_details
  for insert to authenticated
  with check (public.current_user_role() in ('member','admin'));

create policy "member update" on public.product_details
  for update to authenticated
  using (public.current_user_role() in ('member','admin'))
  with check (public.current_user_role() in ('member','admin'));

create policy "admin delete" on public.product_details
  for delete to authenticated
  using (public.current_user_role() = 'admin');
```

### Example — Group B (`discovered_products`)

```sql
alter table public.discovered_products enable row level security;

create policy "member read" on public.discovered_products
  for select to authenticated
  using (public.current_user_role() in ('member','admin'));

create policy "member write" on public.discovered_products
  for all to authenticated
  using (public.current_user_role() in ('member','admin'))
  with check (public.current_user_role() in ('member','admin'));
```

### Example — Group C (`product_feedback`)

```sql
alter table public.product_feedback enable row level security;

create policy "member read" on public.product_feedback
  for select to authenticated
  using (public.current_user_role() in ('member','admin'));

create policy "member insert own" on public.product_feedback
  for insert to authenticated
  with check (
    public.current_user_role() in ('member','admin')
    and user_id = auth.uid()
  );

create policy "delete own or admin" on public.product_feedback
  for delete to authenticated
  using (
    user_id = auth.uid()
    or public.current_user_role() = 'admin'
  );
```

### Example — Group D (`profiles`)

```sql
alter table public.profiles enable row level security;

create policy "self read" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_user_role() = 'admin');

create policy "self update" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "admin all" on public.profiles
  for all to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

create function public.prevent_role_self_escalation() returns trigger
  language plpgsql as $$
begin
  if new.role is distinct from old.role
     and public.current_user_role() <> 'admin' then
    raise exception 'role can only be changed by admin';
  end if;
  return new;
end $$;

create trigger profiles_no_self_escalate
  before update on public.profiles
  for each row execute function public.prevent_role_self_escalation();
```

### Service role

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. Background work (cron, synthesize,
enrich workers, workflow runs) keeps using `getServiceClient()` and is unaffected.

## UI changes

### Navbar (auth-aware)

- Unauth: "Log in" button only.
- viewer: logo links to `/analytics/products`, single menu item ("Products"), user dropdown with role badge + Log out.
- member: existing menu, plus user dropdown.
- admin: existing menu + "User management" link + user dropdown.

`components/Navbar.tsx` becomes a Server Component that receives the session
via props from `app/[locale]/layout.tsx` (no flicker).

### `/[locale]/login`

shadcn `Card` + `Input` + `Button`. Client-side `supabase.auth.signInWithPassword()`.
On error: localized "Invalid email or password". On success: router push by
role.

### `/[locale]/reset-password`

(a) Request form -> `resetPasswordForEmail`, show "Email sent".
(b) Token URL -> new password form -> `updateUser({ password })` -> push to login.

### `/[locale]/admin/users` (admin only)

SSR list of all `profiles`. Inline role `<select>` triggers
`PATCH /api/admin/users/[id]`. Delete with confirm triggers
`DELETE /api/admin/users/[id]` -> `auth.admin.deleteUser()`. No invite button
in Phase 1.

### Disallowed access for viewer

Middleware silently redirects to `/[locale]/analytics/products`. Menu does not
expose the disallowed entries to viewer, so no "Forbidden" screen is needed.

### Session expiry

Client-side fetch wrapper sees 401 -> router push to `/login`. Middleware
refresh keeps this rare.

### i18n additions

`messages/ja.json` and `messages/en.json` get keys under `auth.*`,
`nav.userMenu.*`, `admin.users.*`.

## Code migration

### New files

```
lib/
  supabase/
    server.ts         # getServerClient() — cookie-based, RLS-applied
    middleware.ts     # updateSession() — used by proxy.ts
    service.ts        # re-exports getServiceClient() — RLS-bypassing
  auth/
    require-user.ts   # requireUser(allowed) -> { user, role, sb } or NextResponse error
    route-permissions.ts  # the matrix above as a typed constant
```

`lib/supabase.ts` and its `getServiceClient` keep working unchanged. New code
uses the new helpers; we do not bulk-rewrite call sites.

### `lib/supabase/server.ts`

```ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function getServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) =>
          toSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          ),
      },
    },
  );
}
```

### `lib/auth/require-user.ts`

```ts
type Role = 'admin' | 'member' | 'viewer';

export async function requireUser(allowed: Role[]) {
  const sb = await getServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  const { data: profile } = await sb
    .from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !allowed.includes(profile.role as Role)) {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { user, role: profile.role as Role, sb };
}
```

Per-route usage:

```ts
const auth = await requireUser(['member', 'admin']);
if ('error' in auth) return auth.error;
// auth.user, auth.role, auth.sb
```

### `proxy.ts` (next-intl + auth combined)

```ts
import createIntlMiddleware from 'next-intl/middleware';
import { updateSession } from '@/lib/supabase/middleware';

const intl = createIntlMiddleware({ locales: ['en', 'ja'], defaultLocale: 'ja' });

export async function middleware(req: NextRequest) {
  const { response, user, role } = await updateSession(req);
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith('/api');
  const isPublic = /\/(login|reset-password)$/.test(pathname);
  const isStatic = /\.(svg|png|ico|jpg|jpeg|gif|webp)$/.test(pathname);

  if (isApi || isStatic) return response;
  if (isPublic) return intl(req);

  if (!user) return NextResponse.redirect(new URL('/ja/login', req.url));

  if (role === 'viewer' && !isViewerAllowed(pathname)) {
    return NextResponse.redirect(new URL('/ja/analytics/products', req.url));
  }

  return intl(req);
}

export const config = { matcher: ['/((?!_next|api/cron).*)'] };
```

`isViewerAllowed` allows only the `/[locale]/analytics/products` prefix.

### Required code edits

| File | Change |
|---|---|
| `proxy.ts` | as above |
| `app/[locale]/layout.tsx` | Pass session to `<Navbar />` |
| `components/Navbar.tsx` | Server Component, role-aware menu |
| `app/api/discovery/feedback/route.ts` | `requireUser(['member','admin'])`, attach `user_id: auth.user.id` |
| `app/api/analytics/products/**` | `requireUser(['admin','member','viewer'])` |
| All other `/api/*` (cron excluded) | `requireUser(['member','admin'])` or `['admin']` |
| `app/api/cron/**` | unchanged — Bearer CRON_SECRET |
| `lib/supabase.ts` call sites | only swap to `getServerClient` where the request is user-initiated. No drive-by changes. |

### Convention to add to `CLAUDE.md`

> **Auth usage rule:** Code reached from a user request must use
> `lib/supabase/server.ts::getServerClient()` or
> `lib/auth/require-user.ts::requireUser()`. `getServiceClient()` is reserved
> for cron, workflow, background enrichment — paths that are not user-triggered.
> Calling `getServiceClient()` from user-facing code bypasses RLS and risks
> data leakage.

## Rollout

### Supabase dashboard (one-time, manual)

1. Authentication -> Providers -> Email -> Enable. "Confirm email" OFF (invites are trusted).
2. URL Configuration -> Site URL = production domain, Additional Redirect URLs include `http://localhost:3000`.
3. Email Templates -> add Japanese + English copy for Invite and Reset.
4. Settings -> "Allow new users to sign up" OFF.

### Code rollout (single PR, stepwise commits)

| Step | Work | Deployable? |
|---|---|:---:|
| 1 | SQL migration: `profiles`, trigger, all RLS policies but loose (`using (true)`) — keeps anon working | yes |
| 2 | Add `@supabase/ssr`, new `lib/supabase/server.ts`, `lib/supabase/middleware.ts`, `lib/auth/*` (not yet referenced) | yes |
| 3 | Add `/[locale]/login`, `/reset-password`, `/admin/users` (menu not exposed yet) | yes |
| 4 | Invite first admin via Supabase Studio, log in, `update profiles set role='admin' where email='jp@flowos.work'` | yes |
| 5 | `proxy.ts` auth combined + Navbar auth-aware + `requireUser` on all APIs + tighten RLS policies to role-based — **this step enforces auth** | yes (gate) |
| 6 | Invite remaining members + first external viewer | yes |

### Manual verification (before step 5 deploy)

1. Unauth visit to `/ja` -> redirects to `/ja/login`.
2. Viewer login -> sees only `/ja/analytics/products`; entering `/ja/broadcasts` redirects away.
3. Viewer `curl /api/discovery/feedback` -> 403.
4. Member login -> all existing pages work; feedback click writes `product_feedback.user_id`.
5. Admin login -> `/ja/admin/users` visible; role change works.
6. Cron endpoint with `Bearer ${CRON_SECRET}` -> 200, no session needed.

### Rollback

Step 5 is the only risk gate. If a problem appears:

- (a) Revert the `proxy.ts` change -> auth no longer enforced; data unchanged.
- (b) Pre-prepared SQL to relax RLS policies back to `using (true)` if a query
  is denied unexpectedly.

## Open items resolved in spec

- viewer can read `/api/analytics/products/[code]/images` (TXD details need images).
- viewer keeps the LanguageSwitcher.
- viewer cannot access `/[locale]/gallery`.

## Items the implementation plan must verify

- Enumerate every table and view queried by the viewer-readable routes
  (`app/api/analytics/products/route.ts`,
  `app/api/analytics/products/[code]/route.ts`,
  `app/api/analytics/products/[code]/images/route.ts`) and confirm each is in
  RLS Group A. Initial scan found: `sales_weekly`, `monthly_summaries`,
  `product_details`, `product_summaries`, `product_images`.
- Confirm view definitions (`product_summaries`, `monthly_summaries`, and any
  others) use `security_invoker = true` so RLS on underlying tables applies.
- Inventory every other `.from('<table>')` call across the codebase and assign
  each table to Group B (or D) so no internal table is left without RLS.
- For every `/api/*` route file, decide whether it is user-facing (add
  `requireUser`) or background (keeps `getServiceClient` and `CRON_SECRET`
  header check).

## Out of scope (Phase 2+)

- In-app invite UI.
- Per-resource sharing (e.g., specific clients see specific products).
- Custom learning weight for `user_id is null` historical feedback.
- Multi-tenant org concept.
