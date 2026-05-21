# Dark Mode — Design Spec

**Date:** 2026-05-21
**Status:** Draft
**Owner:** jp@flowos.work

## 1. Goal

Add a user-selectable theme toggle (Light / Dark / System) to the MediaWorks platform. Migrate hardcoded Tailwind color utilities across the app to shadcn semantic tokens so that flipping `<html class="dark">` produces a coherent dark UI with no broken patches.

## 2. Non-Goals

- Persisting theme preference in the database (device-local `localStorage` only).
- Additional themes beyond Light / Dark / System (no high-contrast, sepia, etc.).
- Re-tuning `--chart-1..5` palette values.
- Adding new product features. Only re-skinning + toggle infrastructure.

## 3. Current State

- `app/globals.css` already defines a complete shadcn OKLCH token set for both `:root` (light) and `.dark` (dark), plus the Tailwind v4 `@custom-variant dark (&:is(.dark *))`. **Foundation present.**
- No theme provider is installed. `next-themes` is not in `package.json`.
- `app/layout.tsx` body uses hardcoded `bg-gray-50 min-h-screen`.
- `components/Navbar.tsx` uses `bg-white`, `text-gray-900`, `border-gray-200`, `bg-blue-600`.
- 20+ components under `components/analytics/`, `components/admin/`, `components/broadcasts/`, `components/report/` use hardcoded `bg-gray-*`, `bg-white`, `text-gray-*`.
- PDF export (`components/report/PdfDownload.tsx`) uses html2canvas + jspdf with a `.pdf-mode` CSS class that reveals tabbed/accordion content.

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | 3-way toggle: Light / Dark / System | Standard model; matches user expectations and `next-themes` defaults. |
| D2 | Library = `next-themes` | Solves SSR flash, multi-tab sync, OS preference tracking out of the box. ~1KB. shadcn's official recommendation. Self-rolled provider would re-implement the same edge cases. |
| D3 | Whole-app token migration | Partial migration leaves visible broken patches in dark; one coordinated pass is cleaner than incremental drift. |
| D4 | Toggle UI location = inside UserMenu dropdown | Keeps navbar clean. Discoverable for logged-in users (the audience). Anonymous users on the login page do not need theme switching. |
| D5 | PDF export forces light theme | Dark backgrounds in printed/shared PDFs are inappropriate. Toggle DOM class synchronously around html2canvas, then restore. |
| D6 | Default theme = `system` | Respect OS setting on first visit. Explicit user choice persists thereafter. |
| D7 | Theme stored in `localStorage` only | No server round-trip, no DB schema. Per-device preference is the common pattern. |

## 5. Architecture

```
app/layout.tsx
  <html lang="ja" suppressHydrationWarning>
    <body className={`${inter.className} min-h-screen`}>   ← bg-gray-50 removed
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        {children}
      </ThemeProvider>

app/[locale]/layout.tsx
  <NextIntlClientProvider>
    <Navbar />        ← server component, migrated to semantic tokens
    {children}

components/Navbar.tsx (server)
  └─ <UserMenu />  (client)
        └─ <ThemeSubmenu />  ← new
```

### 5.1 New files

| File | Type | Responsibility |
|---|---|---|
| `components/theme/ThemeProvider.tsx` | Client component | Thin wrapper around `next-themes`'s `<ThemeProvider>`. Single import surface from root layout. |
| `components/theme/ThemeSubmenu.tsx` | Client component | Reads `useTheme()`, renders shadcn `DropdownMenuRadioGroup` with three items (Light / Dark / System) + Lucide `Sun` / `Moon` / `Monitor` icons. Shows `(Dark)` / `(Light)` caption next to "System" to disclose the resolved value. |
| `lib/pdf/with-light-theme.ts` | Server-free util | Async helper that removes `dark` from `<html>`, adds `pdf-mode`, runs a passed-in async fn, then restores the prior state in a `finally` block. |

### 5.2 Modified files (PR 1 only — full mapping in §7)

- `app/layout.tsx` — add `suppressHydrationWarning`, remove `bg-gray-50`, wrap with `ThemeProvider`.
- `components/UserMenu.tsx` — insert `<ThemeSubmenu />` above the logout item with a separator.
- `components/Navbar.tsx` — token migration (see §6).
- `messages/ja.json`, `messages/ko.json` — add `theme.label`, `theme.light`, `theme.dark`, `theme.system` keys.
- `package.json` — add `next-themes` dependency.

## 6. Token Migration Mapping

The whole-app migration follows this **explicit table**. Diverging from it requires a comment explaining why.

### 6.1 Background

| Hardcoded | → Semantic token | Use case |
|---|---|---|
| `bg-white` (card/panel interior) | `bg-card` | Cards, modals, popovers |
| `bg-white` (page outer container) | `bg-background` | Top-level page shell |
| `bg-gray-50` | `bg-muted` | Subtle backgrounds (table headers, section bands) |
| `bg-gray-100` | `bg-muted` | Same as above |
| `bg-gray-200` | `bg-accent` | Hover / selected state |
| `bg-gray-800` / `bg-gray-900` | Case-by-case: `bg-popover` (toast/tooltip) or keep hardcoded (intentional dark button) | Reviewer judgment |

### 6.2 Text

| Hardcoded | → Token |
|---|---|
| `text-gray-900` / `text-black` | `text-foreground` |
| `text-gray-700` / `text-gray-600` (body emphasis) | `text-foreground` |
| `text-gray-700` / `text-gray-600` (captions/metadata) | `text-muted-foreground` |
| `text-gray-500` / `text-gray-400` | `text-muted-foreground` |
| `text-white` (on dark/brand background) | Keep hardcoded OR `text-primary-foreground` if on `bg-primary` |

`text-gray-700` is the ambiguous case: **body emphasis → `foreground`, secondary metadata → `muted-foreground`**. Per-occurrence judgment, not blind replace.

### 6.3 Borders / dividers

| Hardcoded | → Token |
|---|---|
| `border-gray-200` / `border-gray-300` | `border-border` |
| `divide-gray-200` | `divide-border` |

### 6.4 Brand colors (kept hardcoded)

- `bg-blue-600`, `text-blue-600`, `bg-red-600`, etc. — intentional brand/action colors. **No change.**
- Tinted backgrounds like `bg-blue-50`, `bg-red-50` — replace with **opacity variant** of the base: `bg-blue-600/10`, `bg-red-600/10`. These render correctly on both light and dark.
- Channel-style colors in `lib/broadcasts/channel-style.ts` — inspect during PR 3; if contrast is acceptable on dark, keep; otherwise add per-channel dark variants.

### 6.5 Charts

- Recharts / chart components should consume `var(--chart-1)`..`var(--chart-5)` via `getComputedStyle(document.documentElement).getPropertyValue('--chart-N')` or inline `style={{ fill: 'var(--chart-1)' }}`.
- If any chart currently hardcodes a hex, replace with the corresponding `--chart-N` token.
- Token values themselves are not changed in this spec (see §2).

### 6.6 Migration discipline

- **No automated sed**. The `text-gray-700` ambiguity and the case-by-case decisions in §6.1 require human judgment.
- Each PR ends with a `grep -rE "bg-(white|gray-[0-9]+)|text-(gray-[0-9]+|black|white)|border-gray-[0-9]+"` over the changed scope. Surviving hits must be either intentional (with a `// intentional: brand` comment) or fixed in the same PR.

## 7. UX Behavior

### 7.1 Toggle UI

Inside `UserMenu` dropdown, above the logout item, with a `DropdownMenuSeparator`:

```
┌─────────────────────────┐
│ jp@flowos.work          │
│ admin                   │
├─────────────────────────┤
│ テーマ / 테마             │  ← label (i18n)
│  ○ ☀  Light              │
│  ●  Dark              │
│  ○ ▢  System (Dark)     │  ← "(Dark)" / "(Light)" suffix shows resolved value
├─────────────────────────┤
│ ログアウト                │
└─────────────────────────┘
```

- Implemented with shadcn `DropdownMenuRadioGroup` + `DropdownMenuRadioItem` for keyboard / ARIA semantics.
- Click selects immediately. No confirm button.
- Lucide icons: `Sun`, `Moon`, `Monitor`.

### 7.2 i18n keys

```json
{
  "theme": {
    "label": "テーマ" | "테마",
    "light": "ライト" | "라이트",
    "dark": "ダーク" | "다크",
    "system": "システム" | "시스템",
    "systemSuffixDark": "ダーク" | "다크",
    "systemSuffixLight": "ライト" | "라이트"
  }
}
```

### 7.3 Persistence

- `next-themes` writes to `localStorage.theme` automatically. Key name = `theme` (default).
- No DB persistence.
- Multi-tab sync: `next-themes` listens to `storage` events; switching theme in one tab updates all open tabs.

### 7.4 SSR flash prevention

- `ThemeProvider` props: `attribute="class"`, `defaultTheme="system"`, `enableSystem`, `disableTransitionOnChange`.
- `next-themes` injects an inline blocking `<script>` into `<head>` that sets `<html class="dark">` (or removes it) before first paint. Result: no flash.
- `<html suppressHydrationWarning>` required in `app/layout.tsx` to suppress the expected hydration mismatch warning (class attribute differs between server render and post-script state).

### 7.5 Transition behavior

- `disableTransitionOnChange={true}` — all CSS transitions are temporarily disabled during the theme swap. Without this, hundreds of elements would tween their colors over 200ms, producing a visible flicker. Instant swap is the cleaner UX.

### 7.6 Accessibility

- Radio group uses shadcn primitives → ARIA roles + keyboard navigation (↑↓ + Space) inherited.
- Each migration PR runs a Lighthouse a11y check on a representative page in both light and dark. Score must not drop below the pre-migration baseline (capture baseline in PR 1).
- Watch for accidental low-contrast combos created by migration (e.g., `text-muted-foreground` on `bg-muted`). Reviewer scans for these.

### 7.7 PDF export

In `components/report/PdfDownload.tsx`, the capture sequence becomes:

```ts
import { withLightTheme } from '@/lib/pdf/with-light-theme';

await withLightTheme(async () => {
  // existing html2canvas + jspdf logic
});
```

`with-light-theme.ts`:

```ts
export async function withLightTheme<T>(fn: () => Promise<T>): Promise<T> {
  const html = document.documentElement;
  const wasDark = html.classList.contains('dark');
  html.classList.remove('dark');
  html.classList.add('pdf-mode');
  try {
    return await fn();
  } finally {
    html.classList.remove('pdf-mode');
    if (wasDark) html.classList.add('dark');
  }
}
```

Direct DOM mutation is used (not `useTheme().setTheme`) because `setTheme` triggers an async re-render that races the html2canvas snapshot. Synchronous classList toggle guarantees the captured DOM matches the intended theme.

## 8. Rollout Plan (4 PRs)

Each PR must build (`npm run build` + `npx tsc --noEmit`) and pass manual visual verification before merging.

### PR 1 — Infrastructure (small)
- Install `next-themes`.
- Add `components/theme/ThemeProvider.tsx`, `components/theme/ThemeSubmenu.tsx`.
- Modify `app/layout.tsx`, `components/UserMenu.tsx`.
- Migrate `components/Navbar.tsx` tokens.
- Add `theme.*` i18n keys to `messages/{ja,ko}.json`.
- **Verify:** Toggle visible in UserMenu; switching Light↔Dark↔System updates `<html>` class; Navbar renders correctly in both themes; no SSR flash on reload.

### PR 2 — Common UI + Layouts
- Audit `components/ui/*` (badge, button, card, progress, separator, tabs) — confirm they use semantic tokens; fix any that don't.
- All `app/[locale]/(*)/layout.tsx` files.
- Common nav components (`LanguageSwitcher`, `MobileNavSheet`, `GroupDropdown`, `nav/*`).
- **Verify:** All app shells (admin, document, market, produce, firm) render correctly in dark.

### PR 3 — Analytics + Broadcasts (largest)
- All `components/analytics/**` (~20+ files).
- All `components/broadcasts/**`.
- All `components/admin/**`.
- Inspect `lib/broadcasts/channel-style.ts` for hardcoded colors; add dark variants if contrast fails.
- **Verify:** Month grid, broadcast detail panel, historical search panel, discovery hero, MD strategy sections, live commerce panel, margin chart, admin dashboards — all render in dark with readable category chips and channel colors.

### PR 4 — Report + PDF
- All `components/report/**` (13 sections + `PdfDownload`).
- Add `lib/pdf/with-light-theme.ts`; integrate into `PdfDownload`.
- Confirm `.pdf-mode` CSS specificity beats `.dark` rules where needed.
- **Verify:** Dark user downloads a PDF → output is light-background with black text; tabbed content all visible in PDF.
- Final grep check across `components/` and `app/` for surviving hardcoded color utilities; result attached to PR description.

## 9. Verification

Project has no test framework. Verification is build gates + manual visual checks + grep audits.

1. **Build / type gate per PR:** `npm run build` and `npx tsc --noEmit` must pass.
2. **Manual screen matrix per PR:** four theme states (Light / Dark / System-on-light-OS / System-on-dark-OS) × the screens touched in that PR. Use Chrome DevTools MCP to emulate `prefers-color-scheme`.
3. **PDF verification (PR 4):** Trigger PDF download from a dark session; open the resulting PDF; confirm light background and full tab-expanded content.
4. **a11y baseline:** Capture Lighthouse a11y score in PR 1 (before migration) for `/[locale]/analytics/products` and `/[locale]/broadcasts`. Final PR re-runs; score must not drop.
5. **Hardcoded-color audit (final PR):** `grep -rE "bg-(white|gray-[0-9]+)|text-(gray-[0-9]+|black|white)|border-gray-[0-9]+" components/ app/ | grep -v "intentional:"`. Output attached to PR 4 description; any surprises triaged before merge.

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Tinted backgrounds (`bg-blue-50`, `bg-red-50`) widespread → white patches in dark | Visible breakage | Pre-extract via grep; replace with `bg-blue-600/10` form during PR 3. |
| `lib/broadcasts/channel-style.ts` channel colors may be unreadable on dark | Calendar legibility | Audit in PR 3; add dark-variant colors if any channel pair fails AA contrast. |
| html2canvas struggles with OKLCH | PDF rendering artifacts | `pdf-mode` already forces light tokens; verify in PR 4 with a real export. If issues persist, add a `pdf-mode`-specific override using hex values. |
| Recharts consumes hex literals directly | Charts don't follow theme | PR 3 grep finds these; switch to `var(--chart-N)`. |
| Migration miss leaves broken page | Partial breakage in production | Final grep + per-PR screen matrix catches before merge. |
| `text-gray-700` mis-classified (body vs caption) | Wrong emphasis | Reviewer manually inspects each occurrence; not sed-replaced. |

## 11. Open Questions

None at spec-acceptance time. Library, scope, toggle location, PDF behavior, and default theme are all decided above.
