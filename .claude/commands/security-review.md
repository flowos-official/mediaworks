---
description: Mediaworks security review — focused on Supabase RLS, requireUser/role gating, service-role misuse, secrets, and Vercel cron auth. Opus 4.7 at max effort.
---

# /security-review

Strict security pass over the current diff (or specified files). The code-reviewer agent already covers security as one of its priorities; this command runs the security section **alone, at max effort**, with no other concerns competing for attention.

## Usage
```
/security-review
```
Or scope to specific files:
```
/security-review app/api/discovery/feedback/route.ts app/api/selections/[id]/move/route.ts
```

## Model / effort
- Opus 4.7, thinking effort **max**, budget 30k tokens.
- Other reviews can run on Sonnet — security stays on Opus.

## Checks

### 1. Supabase RLS + role gating
- Every new `app/api/**/route.ts` starts with `requireUser([...roles])` and uses `getServerClient()` for DB calls.
- `getServiceClient()` only in `app/api/cron/**`, `lib/workflows/**` step functions, or scripts under `scripts/`. **Any other location = CRITICAL.**
- New `viewer`-readable page → added to `lib/auth/route-permissions.ts::VIEWER_ALLOWED_PATH_PREFIXES`.
- New table → has explicit RLS policy (Group A: TXD, viewer-readable / Group B: member|admin only).
- Internal server-to-server fetch → checks `hasInternalSecret()` against `Bearer ${CRON_SECRET}`.
- Page components: `redirect()` on auth failure, not `return auth.error` (build breaks otherwise).

### 2. Input validation
- All external input parsed with Zod (or equivalent) at the API boundary.
- Boundaries: integer range, string length, array size.
- Query strings on `GET` routes validated (`parseInt` without `Number.isFinite` check = HIGH).
- File uploads bounded to 50MB server-action limit; reject unknown MIME up front.

### 3. Injection
- SQL: only Supabase client params + RPCs; no string-concat SQL. `rpc('execute_sql', ...)` with user input = CRITICAL.
- Command: no `child_process` / `exec` with user input.
- XSS: any prop that takes raw HTML (React's raw-HTML escape hatch, dangerously-marked props) must take sanitized markdown or trusted constants only.
- SSRF: user-supplied URLs (Brave Search results, Rakuten links, QVC scrape) cannot be fetched server-side unless host is allowlisted. `qvc.jp`, `shopch.jp`, `rakuten.co.jp` etc. are the known set.

### 4. Auth / authz
- `auth.uid()` is used in RLS for ownership-scoped tables (`product_selections.owner_id`, etc.).
- IDOR: any `:id` path param read without filtering by `auth.uid()` = HIGH.
- Cron routes (`/api/cron/*`) require `Bearer ${CRON_SECRET}`. Missing = CRITICAL.
- Supabase session refresh handled (next-intl middleware + `@supabase/ssr` should be intact; flag if disrupted).

### 5. Secrets
- No hardcoded `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `BRAVE_SEARCH_API_KEY`, `RAKUTEN_APP_ID`, `CRON_SECRET`, `VIDEO_ARCHIVE_AWS_*` in tracked code.
- `.env.local` not committed (verify via `git ls-files | grep -E '\.env'` produces only `.env.example`).
- Logs don't print secrets (`console.log(headers)` on a route that receives `Authorization` = HIGH).

### 6. PII / customer data
- Profile email / phone / address fields encrypted or access-restricted at the RLS layer.
- Logs of user actions don't include `auth.uid()` joined with PII without need.

### 7. Cloud / Vercel / S3
- AWS keys for video archival: `VIDEO_ARCHIVE_AWS_*` namespace only (avoid colliding with `lib/s3.ts` keys).
- S3 bucket policy: public-read for video archive is intentional (no signed URLs in v1) — flag anything else as inadvertent exposure.
- Vercel functions don't accept unauthenticated webhooks without origin verification.

### 8. Supabase config drift
- `supabase/config.toml` `[auth].enable_signup` — top-level, NOT `[auth.email].enable_signup` (the latter disables the whole provider).
- New migrations land in `supabase/migrations/` with timestamp prefix.

## Output format

```
## /security-review result: [PASS / FAIL]

### CRITICAL findings (must fix before merge)
1. `app/api/foo/route.ts:23` — Missing requireUser; route is reachable by any browser.
   Fix: add `const auth = await requireUser(["member","admin"]); if ("error" in auth) return auth.error;` at the top.

### HIGH findings
...

### MEDIUM findings
...

### Passed checks
- requireUser present on all new API routes
- No service-role usage outside cron/workflow paths
- No hardcoded secrets
- RLS policy present on new table `xyz`
```

## When to bypass
Almost never. If you must, document inside the PR description:
> "Security review bypassed because: <reason>. Reviewer: <human>."

## When NOT to run
- Docs-only changes (no code).
- Pure UI restyling without new data flow.
- Reverts.
