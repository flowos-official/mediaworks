# Product Source Badges Design

**Date:** 2026-05-13
**Status:** Draft — pending user review
**Context:** `/[locale]/analytics/strategy/...` (戦略立案) + audit of `/[locale]/analytics/discovery/...` (商品発掘)

## Problem

On the strategy result pages, a user looking at recommended products cannot see at a glance whether each product came from:

- The user's own **TXD sales catalog** (tier1/tier2 in the channel-product matrix — these are the user's existing products surfaced by AI based on past sales)
- A **TV-shopping channel** the system scraped or searched (shopch / qvc / 日テレ / ディノス / etc.)
- Generic **Rakuten** or **web** search hits

The strategy's `DiscoveredProduct` type already carries the data (`source`, `pool_source`, `tv_channel_source`) and the discovery page's `ProductCard` already renders TV-channel info, but the strategy pages don't. The result is that two products on the same screen — one a user-catalog (TXD) item and one a freshly-discovered Rakuten item — look indistinguishable.

This spec adds the missing badges to the strategy pages and confirms that the discovery page's badges remain correct (audit-only — no change expected).

## Goals

1. On every strategy product card, the user can identify the product's origin at a glance.
2. No new data plumbing — all required fields already exist on `DiscoveredProduct` and on the `tier1_products` shape (the latter is by definition TXD).
3. Zero impact on existing badges already shown on discovery's `ProductCard`.

## Non-goals (separate specs)

- **Spec 2 — Source-mix ratio control.** Limiting TXD's share of the recommended set to ~30–40% and freeing the remainder for fresh discoveries. This requires changes to `discoverNewProducts` and the Gemini prompts in `lib/md-strategy.ts`; it is out of scope here.
- **Spec 3 — Adaptive learning of the source mix.** Letting the system learn the right ratio over time from feedback + downstream sales signals. Depends on Spec 2.
- **Refactoring to a shared badge component library.** The three call sites (`ProductCard`, `DiscoveredProductsHero`, `ProductSelectionSection`) all render small inline pills today; YAGNI says keep them inline until a fourth consumer appears.
- **i18n changes.** "TXD" is a fixed product-classification label; channel display names already come from the registry in their native form (`ショップチャンネル`, `QVC`, `日テレ`…); no new translation keys needed.
- **Brave API quota fix.** Diagnosed in 2026-05-13 prod inspection: the live Brave key has 0/month remaining, which silently fail-opens all TV-channel pool calls and explains why recent cron sessions are 100% Rakuten. Upgrading the Brave plan is a separate operations task and is what restores the TV-channel data the new badges will surface.

## Decision summary

Two small UI additions, both inline JSX in their respective files. No new shared components, no data type changes, no API or schema changes.

| File | Change |
|---|---|
| `components/analytics/DiscoveredProductsHero.tsx` | Render `tv_channel_source` channel-name pills next to the existing `pool_source` pill. Pattern lifted from `components/discovery/ProductCard.tsx`. |
| `components/analytics/md-strategy/ProductSelectionSection.tsx` | Render a static "TXD" pill on every tier1, tier2, and exclusions card. |
| `components/discovery/ProductCard.tsx` | No change. Already renders source + channel badges. Audit only. |

## Design

### §1. Data — already present, no changes

`DiscoveredProduct` (`lib/md-strategy.ts:495–506`) has `tv_channel_source?: string | null`, populated from the discovery pool (`571`) and carried through both `pool_only` and `pool_filled` paths. The orchestrator passes this object straight to the UI; nothing else needs to change.

`ProductSelectionOutput.channel_product_matrix[].tier1_products` etc. (`lib/md-strategy.ts:1246–1266`) carries `code`, `name`, `reason`, etc. — fields that come from the user's `product_summaries` table. By construction every item in these arrays is a TXD-catalog item, so the "TXD" label is a static prop, not a per-item flag.

### §2. `DiscoveredProductsHero.tsx` — add channel pills

Add at the top of the file:

```tsx
import { getChannelBySlug, parseChannelSlugs } from "@/lib/discovery/tv-channels";
```

Inside the product card's component body, near the existing local state, derive:

```tsx
const channelSlugs = parseChannelSlugs(p.tv_channel_source ?? null);
```

In the header's badge row (immediately after the existing `pool_source === "discovery_pool" | "fresh_search" | "seed"` pills, before the `<h3>` product name), render:

```tsx
{channelSlugs.map((slug) => {
  const ch = getChannelBySlug(slug);
  return (
    <span
      key={slug}
      className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 font-semibold"
      title={ch?.name ?? slug}
    >
      {ch?.name ?? slug}
    </span>
  );
})}
```

Style matches `ProductCard.tsx`'s existing channel-pill block so the two views look uniform. Multi-channel hits render multiple pills back-to-back; `parseChannelSlugs` already deduplicates and alphabetizes.

### §3. `ProductSelectionSection.tsx` — add TXD pill

Add a single small helper above the component (no new file):

```tsx
function TxdBadge() {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 font-semibold shrink-0">
      TXD
    </span>
  );
}
```

It's a 5-line static component, scoped to this file. No exports; YAGNI.

Insert `<TxdBadge />` as a left-side prefix to the product name in **tier1** and **tier2** cards:

1. **tier1_products card** (existing layout: name on left, trajectory pill on right). Wrap the name + badge in a flex container:
   ```tsx
   <div className="flex items-center justify-between mb-1">
     <div className="flex items-center gap-1.5 min-w-0">
       <TxdBadge />
       <span className="font-semibold text-sm text-gray-900 truncate">{p.name}</span>
     </div>
     <div className="flex items-center gap-1.5">
       <span className={`text-[10px] px-2 py-0.5 rounded-full border flex items-center gap-1 ${trajectoryColor(p.monthly_trajectory)}`}>
         <TrajectoryIcon trajectory={p.monthly_trajectory} />
         {trajectoryLabel(p.monthly_trajectory)}
       </span>
     </div>
   </div>
   ```
2. **tier2_products card** (existing layout: name then reason in same block). Wrap name and badge in a flex row above the reason:
   ```tsx
   <div className="bg-gray-50 rounded-lg px-3 py-2">
     <div className="flex items-center gap-1.5">
       <TxdBadge />
       <span className="font-medium text-sm text-gray-800 truncate">{p.name}</span>
     </div>
     <p className="text-xs text-gray-500 mt-0.5">{p.reason}</p>
   </div>
   ```
3. **exclusions row — intentionally NOT badged.** Every entry in `exclusions` is by construction a TXD-catalog product (the AI is rejecting it for the channel), so a TXD pill there carries zero information. The row is also already prefixed by the section header `不適合商品` and a red dash, which makes the rejection nature visually dominant. Adding a badge would only add visual noise. (If a future spec introduces non-TXD exclusions — e.g., excluding a freshly-discovered product because of policy — we can revisit.)

### §4. `ProductCard.tsx` — audit, no change

Verified before this spec: lines around 122–140 render the source pill (`楽天 / TV / Web`); lines around 220+ render the channel-name pills via `getChannelBySlug` / `parseChannelSlugs`. Both depend on `product.source` and `product.tv_channel_source` being present on the DB row, which they are when the discovery pipeline produced TV-channel rows (i.e. when Brave Pass D actually returned results).

The user's report of "라쿠텐밖에 검색이 안 됐어" is fully explained by the Brave-quota incident captured in the Non-goals section, not by missing UI. Once Brave Pro is active and the next cron populates `tv_channel_source` on new rows, ProductCard will surface the pills automatically.

### §5. Error handling

- `parseChannelSlugs(null)` returns `[]`; the map produces zero elements; nothing renders. Safe.
- `getChannelBySlug` returns `undefined` for an unknown slug; the fallback renders the raw slug as text. This means a future-added channel slug that hasn't yet been added to the registry still renders something readable, instead of breaking the row.
- TxdBadge has no inputs and cannot fail.

### §6. Testing

No automated tests (codebase has no React component runner). Verification on Vercel preview after merge:

- **Strategy result page (`/ja/analytics/strategy/expansion/[strategyId]` and `/ja/analytics/strategy/live/[resultId]`)** with at least one strategy whose `discovered_new_products` contains `tv_channel_source` non-null rows: confirm the corresponding cards show channel-name pills.
- **Same pages**, on the channel-product matrix block: confirm every tier1 and tier2 card shows a "TXD" pill on the left of the product name; exclusions rows remain unchanged (intentional per §3).
- **Discovery page (`/ja/analytics/discovery/home`)**: confirm no visual regression. Existing pills render unchanged.

The TV-channel pills will only be visible once Brave Pro is restored and a cron run populates fresh rows; this is acknowledged, not a blocker for the UI work.

### §7. Migration / rollback

Component-level diff; revert by reverting the merge commit. No schema, no API, no env-var changes.

## Risks and mitigations

- **TV-channel pills don't appear after merge** because Brave is still at 0/month. Mitigation: documented as a Non-goal; user is upgrading Brave separately. Verification can wait one cron cycle after the Pro upgrade.
- **TXD pill clutters the tier2 / exclusions row** since those rows are denser. Mitigation: the pill uses `text-[10px]` and minimal padding; if it visually fights for space, the wrapping `<div className="flex items-center gap-1.5">` keeps the badge inline-and-tight rather than wrapping to a new line. Adjust during smoke test if needed.
- **Multi-channel pills overflow on narrow cards** when a product appears on 3+ channels. Mitigation: the badge row already uses `flex flex-wrap` in `DiscoveredProductsHero.tsx`; channel pills will simply wrap. No truncation logic added — surfacing all hits is the point.

## Out of scope / follow-ups

- Spec 2 (source-mix ratio control). The TXD pill introduced here is what makes Spec 2's effect visually verifiable ("am I really at 35% TXD?").
- Spec 3 (adaptive learning of the mix).
- A shared badge module (`components/badges/*`). Reasonable to extract once Spec 2 lands, since that work will likely add a fourth badge kind ("ratio-boosted") and a fifth ("learning-suggested").
- Brave Pro upgrade — operational task, performed by the user via brave.com/search/api/.
