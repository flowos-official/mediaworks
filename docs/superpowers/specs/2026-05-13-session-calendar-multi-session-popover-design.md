# SessionCalendar Multi-Session Popover Design

**Date:** 2026-05-13
**Status:** Draft — pending user review
**Context:** `/[locale]/analytics/discovery/history`

## Problem

`components/discovery/SessionCalendar.tsx` renders one day cell per calendar day. When multiple discovery sessions ran on the same day (a common case — typically 2–3 daily cron runs plus any manual triggers), the cell visually indicates the count via up to 4 status dots, but the whole cell is a single `<Link>` that navigates only to `cell.sessions[0]`. There is no way from the calendar UI to reach the 2nd, 3rd, … session of a day — the user must scroll down to the `SessionList` below and find the right row.

The user wants the calendar itself to surface and allow navigation to every session of a day.

## Goals

1. From the calendar view, every session on a day is reachable via clicking the cell.
2. The visual density of the calendar (compact day cells with status dots) is preserved.
3. No regression for days with 0 or 1 session — single-session days still navigate with one click.

## Non-goals

- Replacing or restyling `SessionList` (the chronological row list below the calendar). It stays as-is and continues to serve the time-sorted browsing use case.
- Adding new data to the page or new API endpoints. The existing `SessionRow[]` payload is sufficient.
- Cross-day navigation, search, or filtering inside the popover.
- Applying the same change to `/[locale]/broadcasts` calendar — separate component, separate concerns.
- Per-user preferences for popover behavior.

## Decision summary

Replace each clickable day cell with a Base UI Popover trigger. Clicking a day with sessions opens a popover that lists each session as a row; clicking a row navigates to `/[locale]/analytics/discovery/session/{id}`. Days with no sessions remain non-interactive.

Single-session days remain effectively one-click: the popover does open, but with a single row that is the immediate target. (We deliberately do NOT add a "skip popover for 1-session days" branch — see §6.)

The status-dot cluster currently caps at 4 (`cell.sessions.slice(0, 4)`). Add a `+N` text indicator when more than 4 sessions exist so users see that more is reachable behind the popover.

## Design

### §1. Component changes — `components/discovery/SessionCalendar.tsx`

Replace the existing `Link`-per-cell rendering with a Base UI Popover whose trigger is the cell itself. Pseudo-shape of the new cell render:

```tsx
<Popover.Root>
  <Popover.Trigger
    className="aspect-square ..."
    aria-label={`${month}月${cell.day}日 — ${cell.sessions.length} sessions`}
  >
    <span className="text-[10px] text-gray-700">{cell.day}</span>
    <div className="flex gap-0.5 mt-0.5 items-center">
      {cell.sessions.slice(0, 4).map((s) => <StatusDot session={s} />)}
      {cell.sessions.length > 4 && (
        <span className="text-[9px] text-gray-500 ml-0.5">
          +{cell.sessions.length - 4}
        </span>
      )}
    </div>
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Positioner sideOffset={6} align="start">
      <Popover.Popup className="...card styles...">
        <ul role="list" className="divide-y divide-gray-100">
          {cell.sessions.map((s) => (
            <li key={s.id}>
              <Link
                href={`/${locale}/analytics/discovery/session/${s.id}`}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50"
                onClick={closePopover}
              >
                <span className="font-mono text-[11px] text-gray-500 w-12">{hhmm(s.run_at)}</span>
                <ContextBadge context={s.context} />
                <StatusBadge status={s.status} />
                <span className="text-xs text-gray-600 ml-auto">{s.produced_count}件</span>
              </Link>
            </li>
          ))}
        </ul>
      </Popover.Popup>
    </Popover.Positioner>
  </Popover.Portal>
</Popover.Root>
```

Confirmed against `@base-ui/react@1.3.0` installed in this repo: `import { Popover } from "@base-ui/react/popover"` exposes `Popover.Root`, `Popover.Trigger`, `Popover.Portal`, `Popover.Positioner`, `Popover.Popup` (and additional optional parts like `Arrow`, `Backdrop`, `Close` that we do not need).

Empty-day cells (`cell.day !== null && cell.sessions.length === 0`) render as plain text with no trigger — unchanged from current behavior.

Off-month padding cells (`cell.day === null`) render as empty divs — unchanged.

### §2. Status dot and badge helpers

Extract two small helper components inside the same file to keep the trigger and popup readable:

- `StatusDot({ session })` — replicates the existing color logic (line 90–95) plus the `ring-1 ring-purple-400` for live_commerce context. Already a tiny piece; pulling it out only to reduce trigger-jsx noise.
- Reuse `statusColor()` for the dot; introduce `statusBadgeClasses(status)` only if it cleans up the popup row. If the popup uses bare text (`完了` / `部分` / `失敗` / `実行中`) with color classes, no new helper is needed.

Decide based on size during implementation; do not over-engineer for two short tags.

### §3. Time formatting

The popup needs `HH:MM` per row. Use a single inline formatter:

```ts
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
```

This is sufficient for the JST-only audience and matches the locale already used elsewhere on the page (`toLocaleString("ja-JP")` in SessionList).

### §4. Data and types

No changes. The existing `SessionRow` type carries everything the popup needs: `id`, `run_at`, `status`, `produced_count`, `context`.

### §5. Accessibility and keyboard

Base UI Popover provides:
- ESC closes
- Outside click closes
- Focus moves to the popup on open and returns to the trigger on close
- Focus trap inside the popup while open
- `aria-expanded` / `aria-haspopup` on the trigger

Add explicitly:
- `aria-label` on the trigger button conveying the date and session count
- Each list row is a real `<Link>` so keyboard navigation (Tab) reaches every session

### §6. Why we don't skip the popover for 1-session days

The popover opens at the trigger's anchor with minimal latency, and the single row is the only click target inside — effectively a styled tooltip-list. Adding a conditional "1 session → direct navigate, 2+ → popover" branch creates two interaction models the user must mentally track, and the saved click is marginal. Uniform behavior wins.

### §7. Visual indicator for >4 sessions

The current dot cluster silently truncates to 4 (`slice(0, 4)`). Add an inline `+N` text indicator (e.g., `+2` for 6 sessions) right after the dots so the cell makes the count discoverable. The popup itself lists all without truncation.

### §8. Empty popup edge case

A trigger only renders when `cell.sessions.length > 0`. The popup is never opened with zero rows. Empty days render as a plain text day-number without a Popover wrapper at all (saves a Popover instantiation × ~30 empty cells per month).

### §9. Layout and positioning

`sideOffset={6}` and `align="start"` keep the popup tucked under the day cell. Base UI's Positioner auto-flips to top/right if there isn't enough space below/right — accept default behavior, do not override.

Max width on the popup (`w-56` ≈ 224px) keeps rows readable; rows wrap naturally since the data is short.

### §10. Performance and rendering

Each cell wraps in a `Popover.Root`, which carries a small mount cost. With ~30 cells per month and only the populated cells getting a Root, the cost is negligible. No memoization needed beyond what already exists for `byDay`.

The cache pattern in the parent (`BroadcastCalendar`-style monthly cache) is not relevant here — `DiscoveryHistoryPage` reloads on context/month change via `useEffect` and feeds fresh `SessionRow[]` into `SessionCalendar`.

### §11. Testing

This change is UI-only with no new server-side or pure logic to TDD. Verify manually:
- Day with 1 session: trigger opens, one row, click navigates.
- Day with 4 sessions: trigger opens, four rows, all clickable, no `+N` indicator.
- Day with 6 sessions: trigger shows 4 dots + `+2`; popup lists all 6 rows.
- Day with 0 sessions: no trigger, no popover, plain gray number.
- Keyboard: Tab to trigger, Enter opens, Tab through rows, Enter on a row navigates, ESC closes and returns focus to trigger.

Add a smoke check to `npm run lint` and confirm TypeScript compiles. No automated UI tests are introduced — the existing codebase has no jest/playwright suite for component tests.

### §12. Migration / Rollback

Pure component swap, no schema or API changes. Rollback is reverting the single component file.

## Risks and mitigations

- **Popup overflows the viewport on small widths.** Base UI auto-flips; the popup max-width is 224px so it fits even on mobile. Verify in browser before merge.
- **Click event bubbling.** The popup row uses Next.js `<Link>`; clicking a row should close the popover and navigate. Base UI's Popover should already treat the link click as "outside" → close, but verify before merge — if the link click navigates but the popover lingers visually until the route transition completes, that's a UX glitch worth fixing with an explicit `onClick` close.

## Out of scope / Follow-ups

- Apply the same popover-of-children pattern to the `/[locale]/broadcasts` calendar's day cells (currently each day cell is a clickable `<button>` that filters the right-side day panel — different interaction model, but a similar pattern could surface per-channel detail).
- Search / filter inside the popup (e.g., "show only failed").
- Date range navigation inside the popup (e.g., a "previous day" arrow).
