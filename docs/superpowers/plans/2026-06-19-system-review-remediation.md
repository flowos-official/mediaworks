# System Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified security, permission-UI, data accuracy, and reliability issues found during the full menu/API review, without broad refactors or changing the product's current Group B shared-workspace model.

**Source Review:** Main review plus three read-only subagent confirmations on 2026-06-19.

**Architecture:** Add a small Server Component auth helper for role-aware layouts/pages, harden API routes at the route-handler boundary, make navigation/action rendering derive from the same role rules as APIs, preserve existing service-role usage only behind explicit role gates, and improve user-visible error states where background work or data fetches can fail.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase (`getServerClient`, `getServiceClient`), Tailwind CSS, `next-intl`, `tsx` smoke scripts where needed.

---

## Global Constraints

- Do not change the current "member/admin shared workspace" model for screenplays, MD strategies, and live-commerce strategies in this pass. Treat per-user ownership as a policy follow-up unless the product owner explicitly changes the model.
- Every API route touched in this plan must call `requireUser(...)` or `hasInternalSecret(...)` before service-role data access or workflow access.
- Server Components/layouts must not use `requireUser()` directly because it returns `NextResponse`. Use a Server Component friendly helper.
- UI must not render an action button that the current role cannot successfully use.
- Keep viewer masking policy unchanged except for explicit policy decisions in Task 9.
- Avoid broad nav rewrites. Only add the minimum role filtering needed to make viewer pipeline access coherent.
- Each task should end with targeted verification. Final sweep must include `npx tsc --noEmit` and `npm run lint`.
- No database migration should be introduced unless Task 9 changes the ownership policy.

---

## File Structure

| File | Change |
|------|--------|
| `lib/auth/server-auth.ts` | New Server Component role helper. |
| `app/[locale]/(admin)/admin/layout.tsx` | Gate the whole admin route group to admin. |
| `app/api/screenplays/run/[runId]/status/route.ts` | Add member/admin auth and DB run visibility check. |
| `app/api/screenplays/run/[runId]/stream/route.ts` | Add member/admin auth and DB run visibility check. |
| `lib/nav/groups.ts` | Add per-member role visibility helpers. |
| `components/nav/GroupDropdown.tsx` | Render only role-visible members; single visible member becomes a direct link. |
| `components/nav/MobileNavSheet.tsx` | Mirror role-visible member filtering. |
| `components/nav/GroupSubNav.tsx` | Accept `role` and filter members. |
| `app/[locale]/(market)/layout.tsx` | Pass current role into `GroupSubNav`. |
| `app/[locale]/(firm)/analytics/products/page.tsx` | Hide Taicho upload for viewer; pass selected years to modal. |
| `components/analytics/ProductDetailModal.tsx` | Use selected years from props. |
| `app/api/analytics/products/[code]/route.ts` | Validate year input and filter monthly summaries. |
| `app/[locale]/(market)/analytics/discovery/home/page.tsx` | Convert to server wrapper or pass role-aware props. |
| `app/[locale]/(market)/analytics/discovery/live/page.tsx` | Convert to server wrapper or pass role-aware props. |
| `components/discovery/DiscoveryTodayClient.tsx` | New shared client body for home/live, optional if refactor is chosen. |
| `components/discovery/ManualTriggerButton.tsx` | Remains dumb; rendered only when `canManualTrigger`. |
| `app/api/upload/route.ts` | Add pre-buffer size checks, fail fast on missing internal secret, improve background trigger failure marking. |
| `app/api/analyze/route.ts` | Use request origin or server-only internal URL for synthesize trigger. |
| `components/broadcasts/BroadcastVideoModal.tsx` | Do not render broken relative video URLs when archive base URL is missing. |
| `components/broadcasts/UnifiedDayDetailPanel.tsx` | Show fetch failures distinctly from empty data. |
| `components/analytics/MDStrategyPanel.tsx` | Fix seed dependency handling. |
| `components/analytics/LiveCommercePanel.tsx` | Fix seed dependency handling. |
| `messages/ja.json`, `messages/ko.json` | Add any new UI strings for error/config states. |

---

## Task 1: Server auth helper and admin route-group gate

**Why first:** This closes direct member access to admin registry and prevents future admin pages from repeating the same mistake.

**Files:**
- Create: `lib/auth/server-auth.ts`
- Modify: `app/[locale]/(admin)/admin/layout.tsx`
- Optional cleanup: `app/[locale]/(admin)/admin/users/page.tsx`

- [ ] **Step 1: Create a Server Component friendly auth helper**

Create `lib/auth/server-auth.ts`:

```ts
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServerClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/auth/route-permissions";

export type ServerAuthResult =
  | { ok: true; user: User; role: Role; sb: SupabaseClient }
  | { ok: false; reason: "unauthorized" | "forbidden"; sb: SupabaseClient };

export async function getServerAuth(allowed?: readonly Role[]): Promise<ServerAuthResult> {
  const sb = await getServerClient();
  const { data: { user }, error } = await sb.auth.getUser();
  if (error || !user) return { ok: false, reason: "unauthorized", sb };

  const { data: profile } = await sb
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const role = profile?.role as Role | undefined;
  if (!role || (allowed && !allowed.includes(role))) {
    return { ok: false, reason: "forbidden", sb };
  }

  return { ok: true, user, role, sb };
}
```

- [ ] **Step 2: Gate the admin layout**

Modify `app/[locale]/(admin)/admin/layout.tsx` to accept `params`, call `getServerAuth(["admin"])`, and redirect:

- unauthorized -> `localePath(locale, "/login")`
- forbidden -> `localePath(locale)`

Add `export const dynamic = "force-dynamic";` because the layout now depends on request cookies.

- [ ] **Step 3: Keep child page checks for now**

Do not remove existing per-page admin checks in this task. They are redundant after layout gating but harmless. Cleanup can happen after verification.

- [ ] **Step 4: Verify**

Run:

```bash
npx tsc --noEmit
```

Manual:

- admin can open `/admin/users` and `/admin/registry`
- member direct-open `/admin/registry` redirects to the localized home
- logged-out direct-open `/admin/registry` redirects to login

---

## Task 2: Harden screenplay workflow run APIs

**Why:** These are the only `app/api` route handlers found without auth or internal-secret protection, and `/api` bypasses middleware.

**Files:**
- Modify: `app/api/screenplays/run/[runId]/status/route.ts`
- Modify: `app/api/screenplays/run/[runId]/stream/route.ts`

- [ ] **Step 1: Add shared runId guard logic in each route**

Use the same validation in both files:

```ts
const RUN_ID_RE = /^wrun_[A-Z0-9]+$/i;
```

Reject malformed IDs before `getRun`.

- [ ] **Step 2: Add `requireUser(["member", "admin"])`**

At the top of `GET`, before `getRun(runId)`:

```ts
const auth = await requireUser(["member", "admin"]);
if ("error" in auth) return auth.error;
```

- [ ] **Step 3: Bind run visibility to DB state**

Before `getRun(runId)`, verify the run belongs to a known screenplay:

```ts
const { data, error } = await auth.sb
  .from("screenplays")
  .select("id")
  .eq("last_run_id", runId)
  .maybeSingle();
if (error) return Response.json({ error: error.message }, { status: 500 });
if (!data) return Response.json({ error: "run not found" }, { status: 404 });
```

This does not add per-user ownership. It only prevents arbitrary workflow run probing and matches the current Group B shared screenplay model.

- [ ] **Step 4: Verify**

Run:

```bash
npx tsc --noEmit
```

Manual/API:

- unauthenticated `GET /api/screenplays/run/<validish>/status` returns `401`
- viewer returns `403`
- member/admin with a valid `last_run_id` can stream/poll normally
- unknown well-formed run returns `404` before workflow probing

---

## Task 3: Make viewer pipeline navigation coherent

**Decision for this plan:** Keep viewer read-only access to `/analytics/pipeline`, because the page already uses `canWrite = auth.role !== "viewer"` and `VIEWER_ALLOWED_PATH_PREFIXES` explicitly includes the route.

**Files:**
- Modify: `lib/nav/groups.ts`
- Modify: `components/nav/GroupDropdown.tsx`
- Modify: `components/nav/MobileNavSheet.tsx`
- Modify: `components/nav/GroupSubNav.tsx`
- Modify: `app/[locale]/(market)/layout.tsx`

- [ ] **Step 1: Add member-level role visibility**

Extend `NavMember`:

```ts
roles?: readonly Role[];
```

Add helper:

```ts
export function visibleMembersForRole(group: NavGroup, role: Role): NavMember[] {
  return group.members.filter((m) => !m.roles || m.roles.includes(role));
}
```

- [ ] **Step 2: Annotate Market members**

In `NAV_GROUPS.market.members`:

- broadcasts: `["admin", "member"]`
- discovery: `["admin", "member"]`
- strategy: `["admin", "member"]`
- pipeline: `["admin", "member", "viewer"]`

Keep admin group hidden for member/viewer. Keep firm `productsOnly` behavior unchanged for viewer.

- [ ] **Step 3: Filter desktop and mobile nav**

In `GroupDropdown` and `MobileNavSheet`, derive visible members through `visibleMembersForRole`.

If a group has no visible members, render nothing.

If a group has exactly one visible member and the group is not `productsOnly`, render a direct link to that member. This gives viewer a direct Pipeline link without exposing Broadcasts/Discovery/Strategy.

- [ ] **Step 4: Filter sub-nav**

Change `GroupSubNav` props to:

```ts
interface GroupSubNavProps {
  groupKey: GroupKey;
  role: Role;
}
```

Render only `visibleMembersForRole(group, role)`.

In `app/[locale]/(market)/layout.tsx`, call `getServerAuth(["viewer", "member", "admin"])` and pass `auth.role`. Redirect unauthorized users to login. This prevents viewer direct access from showing member-only sub-nav items.

- [ ] **Step 5: Verify**

Manual:

- viewer top nav shows Products and Pipeline only
- viewer `/analytics/pipeline` shows only Pipeline in the Market sub-nav
- viewer cannot access `/broadcasts`, `/analytics/discovery`, or `/analytics/strategy`
- member/admin Market nav remains full

---

## Task 4: Align visible action buttons with API permissions

**Files:**
- Modify: `app/[locale]/(firm)/analytics/products/page.tsx`
- Modify: `app/[locale]/(market)/analytics/discovery/home/page.tsx`
- Modify: `app/[locale]/(market)/analytics/discovery/live/page.tsx`
- Optional create: `components/discovery/DiscoveryTodayClient.tsx`

### Part A: Taicho upload

- [ ] **Step 1: Track `viewer` from `/api/analytics/products`**

The products API already returns `viewer`. Update the local products state type from:

```ts
{ products: unknown[]; total: number }
```

to include:

```ts
viewer?: boolean;
```

- [ ] **Step 2: Hide upload UI for viewer**

Wrap the Taicho upload button and modal with `!products.viewer`.

Do not merely disable the button. The action is not available to viewer.

### Part B: Discovery manual trigger

- [ ] **Step 3: Convert discovery home/live pages to server wrappers**

Current home/live pages are client components. Move their client body into a shared component, for example:

```txt
components/discovery/DiscoveryTodayClient.tsx
```

Props:

```ts
type DiscoveryTodayClientProps = {
  context: "home_shopping" | "live_commerce";
  canManualTrigger: boolean;
};
```

Server pages call `getServerAuth(["member", "admin"])` and pass:

```ts
canManualTrigger={auth.ok && auth.role === "admin"}
```

- [ ] **Step 4: Render `ManualTriggerButton` only for admin**

Inside the client component:

```tsx
{canManualTrigger && (
  <ManualTriggerButton context={context} onStarted={() => setTimeout(load, 180_000)} />
)}
```

- [ ] **Step 5: Verify**

Manual:

- viewer cannot access discovery
- member can open discovery but does not see manual trigger
- admin sees manual trigger and POST succeeds
- Products viewer does not see Taicho upload
- Products member/admin still see Taicho upload

---

## Task 5: Fix product detail year filtering

**Files:**
- Modify: `app/[locale]/(firm)/analytics/products/page.tsx`
- Modify: `components/analytics/ProductDetailModal.tsx`
- Modify: `app/api/analytics/products/[code]/route.ts`

- [ ] **Step 1: Pass selected years into the modal**

In `ProductsPage`, pass:

```tsx
<ProductDetailModal
  productCode={selectedProduct}
  years={selectedYears}
  onClose={() => setSelectedProduct(null)}
/>
```

- [ ] **Step 2: Update modal props and fetch**

In `ProductDetailModal`, add:

```ts
years?: number[];
```

Build the query from props:

```ts
const yearParam = (years?.length ? years : [2025, 2026]).join(",");
fetch(`/api/analytics/products/${productCode}?year=${encodeURIComponent(yearParam)}`)
```

Include `yearParam` or `years` in the effect dependencies so the modal refetches when the global filter changes.

- [ ] **Step 3: Validate years in detail API**

In `app/api/analytics/products/[code]/route.ts`, reject invalid year input:

```ts
const years = yearParam.split(",").map(Number);
if (years.length === 0 || years.some((y) => !Number.isInteger(y) || y < 2000 || y > 2100)) {
  return NextResponse.json({ error: "Invalid year parameter" }, { status: 400 });
}
```

- [ ] **Step 4: Filter `monthly_summaries`**

Apply the same selected-year constraint to monthly summaries. If `year_month` is text in `YYYY-MM` form, use:

```ts
.or(years.map((y) => `and(year_month.gte.${y}-01,year_month.lte.${y}-12)`).join(","))
```

Keep weekly and monthly filters semantically aligned.

- [ ] **Step 5: Verify**

Manual:

- select only `2026`, open a product, weekly and monthly charts show 2026 only
- select `2025,2026`, charts show both years
- invalid `?year=abc` returns `400`

---

## Task 6: Stop research upload from reporting false success

**Files:**
- Modify: `app/api/upload/route.ts`
- Modify: `app/api/analyze/route.ts`

**Scope:** This task does not replace the pipeline with a durable queue. It only prevents obvious success misreporting and wrong-origin follow-up calls.

- [ ] **Step 1: Add pre-buffer file size checks in upload**

Before `file.arrayBuffer()`:

```ts
const MAX_SINGLE_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024;
```

Reject any single file over 15MB and reject the request if the supported files' total size exceeds 20MB. Do this before storage writes and product row creation.

- [ ] **Step 2: Fail fast if `CRON_SECRET` is missing**

Move the `CRON_SECRET` check before storage upload/product insert. If missing:

```ts
return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
```

This avoids creating a product that cannot be analyzed.

- [ ] **Step 3: Mark trigger failures explicitly**

Keep the async trigger, but make failure handling update the product:

```ts
void fetch(`${baseUrl}/api/analyze`, { ... })
  .then(async (res) => {
    if (!res.ok) {
      await supabase.from("products")
        .update({ status: "failed", error_reason: `analyze_trigger_http_${res.status}` })
        .eq("id", product.id);
    }
  })
  .catch(async () => {
    await supabase.from("products")
      .update({ status: "failed", error_reason: "analyze_trigger_failed" })
      .eq("id", product.id);
  });
```

Do not await full analysis in the upload response path.

- [ ] **Step 4: Replace public-site URL in analyze**

In `/api/analyze`, replace:

```ts
process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"
```

with:

```ts
process.env.INTERNAL_APP_URL || request.nextUrl.origin
```

`INTERNAL_APP_URL` is server-only and optional. If absent, same-origin is used.

- [ ] **Step 5: Improve synthesize trigger failure marking**

Keep synthesize async, but if the trigger itself rejects, mark the product failed with `error_reason: "synthesize_trigger_failed"`. If choosing to inspect `res.ok`, remember that awaiting the synthesize response may wait for full synthesis; do not block `/api/analyze` longer than its current `maxDuration`.

- [ ] **Step 6: Verify**

Manual/API:

- upload >15MB file returns `400` before DB row creation
- missing `CRON_SECRET` returns `500` before DB row creation
- normal upload still creates a product and starts analysis
- analyze logs show same-origin or `INTERNAL_APP_URL`, not `NEXT_PUBLIC_SITE_URL`

---

## Task 7: Make Broadcast failures visible

**Files:**
- Modify: `components/broadcasts/BroadcastVideoModal.tsx`
- Modify: `components/broadcasts/UnifiedDayDetailPanel.tsx`
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`

- [ ] **Step 1: Guard missing archive video base URL**

In `BroadcastVideoModal`, compute:

```ts
const archiveBaseUrl = process.env.NEXT_PUBLIC_VIDEO_ARCHIVE_BASE_URL;
const videoUrl = archiveBaseUrl && videoKey ? `${archiveBaseUrl.replace(/\/$/, "")}/${videoKey.replace(/^\//, "")}` : null;
```

If `videoUrl` is null, render a clear configuration error instead of `<video><source src="/..."></video>`.

- [ ] **Step 2: Add translations**

Add keys under `broadcasts`, for example:

```json
"videoArchiveNotConfigured": "..."
```

Use Japanese/Korean wording consistent with surrounding broadcast messages.

- [ ] **Step 3: Show day-detail fetch failures before empty state**

In `UnifiedDayDetailPanel`, if `!loading && totalShown === 0 && (timedError || oaError)`, render `t("unified.fetchFailed")` or a new `unified.fetchAllFailed` message instead of `empty.day`.

If one source failed but the other has rows, show a small warning above the sections rather than only appending text to sections that may not render.

- [ ] **Step 4: Verify**

Manual:

- unset `NEXT_PUBLIC_VIDEO_ARCHIVE_BASE_URL`; clicking archived video shows config error, not a broken player
- mock/fail both broadcast fetches; selected day shows fetch failure, not empty day
- one failed source plus one successful source shows partial failure warning

---

## Task 8: Fix strategy seed dependency warnings

**Files:**
- Modify: `components/analytics/MDStrategyPanel.tsx`
- Modify: `components/analytics/LiveCommercePanel.tsx`

- [ ] **Step 1: Memoize MD seed list**

In `MDStrategyPanel`, wrap `seedProductIds` in `useMemo`:

```ts
const seedProductIds = useMemo(
  () => seedProductIdsRaw
    ? seedProductIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null,
  [seedProductIdsRaw],
);
```

Add `useMemo` import if needed.

- [ ] **Step 2: Fix MD `handleGenerate` dependencies**

Add `seedProductId` and `seedProductIds` to the dependency array.

- [ ] **Step 3: Fix Live Commerce dependency**

In `LiveCommercePanel`, add `seedProductId` to `handleGenerate` dependencies.

- [ ] **Step 4: Verify**

Run:

```bash
npm run lint -- components/analytics/MDStrategyPanel.tsx components/analytics/LiveCommercePanel.tsx
npx tsc --noEmit
```

Expected: no `react-hooks/exhaustive-deps` warnings for these two callbacks.

---

## Task 9: Policy decisions and optional follow-up implementation

These items were confirmed as real behavior, but not necessarily bugs under the current documented model.

### Policy A: viewer contact visibility

Current behavior:

- viewer cannot see cost, wholesale rate, margin, or profit
- viewer can still see contacts/supplier/order/return/shipping information in product detail

- [ ] **Decision A1: Keep current policy**

Document that viewer masking is financial-only. No code change.

- [ ] **Decision A2: Treat contact data as confidential**

If selected, modify:

- `app/api/analytics/products/[code]/route.ts`: null out contact/address/logistics-sensitive fields for viewer
- `components/analytics/ProductDetailModal.tsx`: hide `contacts` tab for viewer
- messages if needed

Verification:

- viewer API response contains no contact fields
- viewer modal has no Contacts tab
- member/admin still see contacts

### Policy B: screenplay/strategy ownership

Current behavior:

- `screenplays`, `md_strategies`, and `live_commerce_strategies` are Group B shared data for member/admin
- detail/delete/refine/rediscover are not per-user owned

- [ ] **Decision B1: Keep shared workspace**

Document this explicitly. No migration.

- [ ] **Decision B2: Make artifacts private/owned**

If selected, create a separate plan. It needs:

- migrations adding `created_by` or `owner_id`
- backfill strategy
- RLS changes
- API filters on GET/DELETE/refine/rediscover/check/changes
- UI rules for admin override

Do not mix this into the current remediation pass.

---

## Task 10: Final verification sweep

**Files:** none, unless fixing discovered issues.

- [ ] **Step 1: Static checks**

Run:

```bash
npx tsc --noEmit
npm run lint
```

Known prior lint errors exist in unrelated strategy/test files. If this plan does not address all lint debt, record the remaining pre-existing errors separately and ensure no new errors/warnings are introduced by changed files.

- [ ] **Step 2: Targeted role walkthrough**

Use real or seeded accounts:

- admin
- member
- viewer

Checklist:

- admin can use admin pages and registry
- member cannot direct-open any `/admin/*` page
- viewer sees Products and Pipeline only
- viewer Product detail respects selected year filter
- viewer cannot see or trigger upload/discovery admin actions
- member Discovery does not show manual trigger
- admin Discovery shows manual trigger and it works
- member/admin Taicho upload still works

- [ ] **Step 3: Research workflow smoke**

Checklist:

- normal upload creates product and starts analysis
- too-large file rejected before product creation
- missing `CRON_SECRET` rejected before product creation
- analyze uses same-origin or `INTERNAL_APP_URL`

- [ ] **Step 4: Broadcast UI smoke**

Checklist:

- missing video archive env shows config message
- failed day fetch shows failure message
- normal day still shows timed/OA rows

- [ ] **Step 5: Regression check on core menus**

Walk through:

- Firm: overview, products, gallery
- Market: broadcasts, discovery, strategy, pipeline
- Produce: screenplays, research
- Admin: users, historical crawl, discovery calibration, compliance rules/references, registry, preferences

Record any remaining issues as a new review note, not as hidden implementation changes.

---

## Acceptance Criteria

- No unauthenticated or viewer access to screenplay run status/stream.
- No member access to admin registry or any admin route-group child page.
- Viewer navigation matches viewer route permissions.
- UI no longer shows actions that the current role cannot execute.
- Product detail weekly and monthly data both respect selected years.
- Upload rejects oversized or untriggerable analysis requests before reporting success.
- Analyze no longer uses `NEXT_PUBLIC_SITE_URL` for server-to-server synthesize calls.
- Broadcast video/config and fetch failures are visible to users.
- Strategy seed dependency lint warnings are gone.
- Policy-sensitive items are either documented as current policy or split into a follow-up plan.

---

## Self-Review

- **Security first:** Tasks 1-2 close the direct access issues before UX/data fixes.
- **Functional correctness:** Tasks 4-8 address confirmed user-facing failures and stale data behavior.
- **Policy boundaries:** Task 9 deliberately avoids silently changing viewer confidentiality or shared-workspace semantics.
- **No overreach:** Durable queue/workflow migration for Research is not included. This plan only fixes false success and wrong-origin triggers within the current architecture.
