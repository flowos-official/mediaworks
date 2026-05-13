# Product Source Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every recommended product on the strategy result pages legible at a glance — TV-channel pills on freshly-discovered products, a `TXD` pill on user-catalog (tier1/tier2) products.

**Architecture:** Two inline UI edits in two files. No new shared components, no data plumbing, no schema changes. The strategy types already carry `tv_channel_source` on `DiscoveredProduct`; tier1/tier2 items are TXD by construction (sourced from `product_summaries`). One small file-local `TxdBadge` helper, channel-pill markup lifted from `components/discovery/ProductCard.tsx`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind CSS 4, lucide-react. Existing helpers from `@/lib/discovery/tv-channels` (already shipped).

**Spec reference:** `docs/superpowers/specs/2026-05-13-product-source-badges-design.md`

**Worktree:** Implementation runs in `../mediaworks-source-badges` on branch `feat/product-source-badges` (created at HEAD `cf021ea` from `origin/main`). Per the auto-memory rule, all subagent dispatches must verify the working directory is the worktree path before touching files — never modify the main repo at `E:/Github/mediaworks` directly during this work.

---

## File Structure

**Modify (in worktree `../mediaworks-source-badges`):**
- `components/analytics/DiscoveredProductsHero.tsx` — add TV-channel pills to each discovered-product card header.
- `components/analytics/md-strategy/ProductSelectionSection.tsx` — add `TxdBadge` helper and render it as a left-side prefix on tier1 + tier2 cards.

**Audit (no change expected):**
- `components/discovery/ProductCard.tsx` — already renders source + channel badges. Confirmed in spec §4.

**Tests:**
- None automated (codebase has no React component runner). Verification is manual on Vercel preview, captured in Task 3.

---

## Task 1: Add TV-channel pills to `DiscoveredProductsHero.tsx`

The strategy's discovered-products card already shows source (`楽天 / Web`) and pool source (`発掘プール / 新検索 / シード`). This task adds a third row of pills — one per `tv_channel_source` slug — using the same purple style and the same registry-lookup helpers that `components/discovery/ProductCard.tsx` already uses.

**Files:**
- Modify: `components/analytics/DiscoveredProductsHero.tsx`

- [ ] **Step 1: Add the registry imports**

Open `components/analytics/DiscoveredProductsHero.tsx`. The file already has a handful of imports at the top. Add one new line for the channel registry helpers:

```ts
import { getChannelBySlug, parseChannelSlugs } from "@/lib/discovery/tv-channels";
```

Put it after the existing import block for `@/lib/...` types if there is one, or alongside the other `@/`-prefixed imports — match the file's existing import grouping style.

- [ ] **Step 2: Derive channel slugs inside the per-product card body**

Inside the per-product card component (the one that renders the header with source + pool_source pills — search for the `p.source === 'rakuten'` block to locate it), add this line near the existing `const [expanded, setExpanded] = useState(false);` or wherever the component's local derivations live:

```ts
const channelSlugs = parseChannelSlugs(p.tv_channel_source ?? null);
```

`p` is the per-product prop already in scope; this just reads the existing `tv_channel_source` field (defined on `DiscoveredProduct` at `lib/md-strategy.ts:504`).

- [ ] **Step 3: Render the channel pills**

In the header's flex-wrap badge row, immediately after the last `pool_source === "seed"` pill closing `</span>` and BEFORE the `<h3>` that renders the product name, insert:

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

This mirrors the channel-pill block in `components/discovery/ProductCard.tsx` line-for-line in style. When `channelSlugs` is empty (no TV channels matched), the `.map` produces nothing — zero visual change for those products.

- [ ] **Step 4: Verify TypeScript**

Run from the worktree:
```bash
cd ../mediaworks-source-badges
npx tsc --noEmit
```
Expected: clean exit, no output.

- [ ] **Step 5: Commit**

```bash
git add components/analytics/DiscoveredProductsHero.tsx
git commit -m "feat(strategy): show TV channel pills on discovered products"
```

---

## Task 2: Add `TxdBadge` to `ProductSelectionSection.tsx`

The channel-product matrix shows tier1 and tier2 cards drawn from the user's TXD catalog. This task introduces a single small file-local helper and threads it into both card variants as a left-side prefix to the product name. Exclusions rows are intentionally NOT modified (see spec §3 — all exclusions are by construction TXD, so a badge there carries zero information).

**Files:**
- Modify: `components/analytics/md-strategy/ProductSelectionSection.tsx`

- [ ] **Step 1: Add the `TxdBadge` helper**

Open `components/analytics/md-strategy/ProductSelectionSection.tsx`. Just below the existing `trajectoryColor` function (around line 38) and ABOVE `export default function ProductSelectionSection`, insert:

```tsx
function TxdBadge() {
	return (
		<span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 font-semibold shrink-0">
			TXD
		</span>
	);
}
```

5 lines, file-local, no exports. The `shrink-0` class prevents it from collapsing when the product name is long.

- [ ] **Step 2: Update tier1 card layout to include the TxdBadge**

Locate the tier1 card render (currently around lines 70–88 — search for `tier1_products ?? []).map`). The current name + trajectory row looks like:

```tsx
<div className="flex items-center justify-between mb-1">
	<span className="font-semibold text-sm text-gray-900">{p.name}</span>
	<div className="flex items-center gap-1.5">
		<span className={`text-[10px] px-2 py-0.5 rounded-full border flex items-center gap-1 ${trajectoryColor(p.monthly_trajectory)}`}>
			<TrajectoryIcon trajectory={p.monthly_trajectory} />
			{trajectoryLabel(p.monthly_trajectory)}
		</span>
	</div>
</div>
```

Replace the entire `<div className="flex items-center justify-between mb-1">` block with:

```tsx
<div className="flex items-center justify-between mb-1 gap-2">
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

Three changes from the original: outer flex gets `gap-2` (separation between left group and trajectory pill); a new inner `<div className="flex items-center gap-1.5 min-w-0">` wraps `<TxdBadge />` and the name; the name gets `truncate` plus `min-w-0` on its container so long names ellipsize instead of overflowing.

- [ ] **Step 3: Update tier2 card layout to include the TxdBadge**

Locate the tier2 card render (currently around lines 100–106 — search for `tier2_products ?? []).map`). The current block is:

```tsx
<div key={p.code} className="bg-gray-50 rounded-lg px-3 py-2">
	<span className="font-medium text-sm text-gray-800">{p.name}</span>
	<p className="text-xs text-gray-500 mt-0.5">{p.reason}</p>
</div>
```

Replace with:

```tsx
<div key={p.code} className="bg-gray-50 rounded-lg px-3 py-2">
	<div className="flex items-center gap-1.5">
		<TxdBadge />
		<span className="font-medium text-sm text-gray-800 truncate">{p.name}</span>
	</div>
	<p className="text-xs text-gray-500 mt-0.5">{p.reason}</p>
</div>
```

Same pattern as tier1 but in a single-column card. The name + badge sit on one row above the reason text.

- [ ] **Step 4: Verify exclusions are unchanged**

Search the file for `exclusions ?? []).map`. Confirm the row render is still:

```tsx
<div key={p.code} className="flex items-start gap-2 text-xs text-gray-500">
	<span className="text-red-400">-</span>
	<span><span className="text-gray-700">{p.name}</span>: {p.reason}</span>
</div>
```

If anything in this block was changed by mistake, revert it. Exclusions intentionally stay badge-less per spec §3.

- [ ] **Step 5: Verify TypeScript**

```bash
cd ../mediaworks-source-badges
npx tsc --noEmit
```
Expected: clean exit, no output.

- [ ] **Step 6: Verify lint**

```bash
cd ../mediaworks-source-badges
npm run lint
```
Expected: no new warnings or errors in `ProductSelectionSection.tsx` (pre-existing ones in other files are out of scope).

- [ ] **Step 7: Commit**

```bash
git add components/analytics/md-strategy/ProductSelectionSection.tsx
git commit -m "feat(strategy): show TXD badge on tier1/tier2 product cards"
```

---

## Task 3: Manual verification on Vercel preview

No code changes. Push the branch, wait for the Vercel preview, then walk the verification checklist from spec §6 against the deployed preview.

**Files:** None.

- [ ] **Step 1: Push the worktree's branch and create a Pull Request**

```bash
cd ../mediaworks-source-badges
git push -u origin feat/product-source-badges
gh pr create --base main --head feat/product-source-badges \
	--title "feat(strategy): product source badges (TXD + TV channel)" \
	--body "$(cat <<'EOF'
## Summary

Strategy result pages don't show product origin. This PR adds:
- `TxdBadge` (small gray "TXD" pill) on every tier1 and tier2 card in the channel-product matrix.
- TV-channel name pills (purple, sourced from \`@/lib/discovery/tv-channels\`) next to the existing pool_source pills on every discovered-product card in DiscoveredProductsHero.

Exclusions rows are intentionally not badged — every exclusion is TXD by construction (spec §3).

## Test plan

After merge and one Brave-API-Pro-active cron cycle, on \`/ja/analytics/strategy/...\` result pages:
- [ ] tier1 cards show TXD pill on the left of the product name
- [ ] tier2 cards show TXD pill on the left of the product name
- [ ] exclusions rows are unchanged (no TXD pill)
- [ ] discovered-product cards with \`tv_channel_source\` show channel pills next to the pool_source pill
- [ ] discovery page \`/ja/analytics/discovery/home\` shows no regression — ProductCard's existing channel pills render unchanged

Spec: docs/superpowers/specs/2026-05-13-product-source-badges-design.md
EOF
)"
```

The PR URL is reported back; record it for Step 3.

- [ ] **Step 2: Wait for the Vercel preview check to succeed**

```bash
cd ../mediaworks-source-badges
gh pr checks $(gh pr view --json number --jq '.number')
```

Repeat until `Vercel` reports `pass`. Expected duration: 1–3 minutes for a typical preview build.

- [ ] **Step 3: Find the preview URL and open the strategy result pages**

```bash
cd ../mediaworks-source-badges
gh pr view --json comments --jq '.comments[0].body' | grep -oE 'mediaworks-git-[a-z0-9-]+\.vercel\.app' | head -1
```

Expected output: a hostname like `mediaworks-git-feat-product-source-badges-xxxxxx-flow-os.vercel.app`. Open `https://<that-host>/ja/analytics/strategy/expansion` or `/ja/analytics/strategy/live` in a browser and pick any saved strategy result that has at least one discovered new product.

- [ ] **Step 4: Walk the checklist**

For each item below, observe and write a one-line PASS/FAIL note. `N/A — data not visible` is acceptable if the data shape isn't present on the strategies currently in dev DB; flag those as "verify after next strategy run".

- [ ] **tier1 TXD pill** — pick a strategy with tier1 products. Each tier1 card has a small gray "TXD" pill immediately left of the product name; the trajectory pill (`上昇 / 安定 / 下降`) still sits on the right.
- [ ] **Long-name truncation** — if any tier1 product name is long enough to overflow, it ellipsizes rather than pushing the trajectory pill off the card.
- [ ] **tier2 TXD pill** — every tier2 card shows the TXD pill above the reason text, on the same row as the product name.
- [ ] **Exclusions unchanged** — every exclusions row still renders as the red-dash + name + reason layout, no TXD pill.
- [ ] **DiscoveredProductsHero channel pills** — find a strategy whose `discovered_new_products` includes a row with non-null `tv_channel_source`. The corresponding card shows the channel name as a purple pill in the badge row. If no such row exists (typical right now because the Brave plan is at 0/month), document this as "N/A — verify after Brave Pro restores TV-channel cron data".
- [ ] **DiscoveredProductsHero no regression** — for products without a `tv_channel_source` (the majority right now), the badge row shows source + pool_source pills as before, unchanged.
- [ ] **Discovery page no regression** — load `/ja/analytics/discovery/home` on the same preview. Existing ProductCard channel pills render exactly as before. (Should be unchanged — this PR doesn't touch ProductCard.)
- [ ] **Browser console** — open devtools. No new React warnings or hydration errors caused by this PR. Pre-existing warnings (e.g. the `/ja:0` 400 we saw earlier) are out of scope.

- [ ] **Step 5: Report findings**

If everything passes, comment on the PR with a short note: "Manual preview verification: all checklist items PASS." If items failed, report the failure on the PR and either fix in the worktree (a new commit, then re-verify) or escalate to the controller agent.

No commit in this task.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Data — no changes | n/a (acknowledged in plan header) |
| §2 DiscoveredProductsHero — TV channel pills | Task 1 |
| §3 ProductSelectionSection — TXD pill on tier1/tier2, exclusions intentionally skipped | Task 2 |
| §4 ProductCard — audit, no change | Task 3 Step 4 (discovery-page no-regression check) |
| §5 Error handling — empty `tv_channel_source`, unknown slug, etc. | Inherent in Task 1 Step 3 (`.map` over empty array, `getChannelBySlug` fallback) |
| §6 Testing — manual checklist on Vercel preview | Task 3 |
| §7 Migration / rollback | n/a — single PR, revert by reverting merge commit |

All spec sections covered.

**2. Placeholder scan:**

No "TBD", "implement later", "similar to Task N", or vague instructions. Every step shows the exact code or command. Task 3 has a real Vercel-preview workflow rather than a hand-wave at "test it."

**3. Type consistency:**

- `parseChannelSlugs` (Task 1) and `getChannelBySlug` (Task 1) — both already exported from `@/lib/discovery/tv-channels`, signatures confirmed in earlier SessionCalendar work.
- `TxdBadge` (Task 2) — file-local, parameterless, takes no props.
- `p.tv_channel_source` (Task 1) — typed as `string | null | undefined` per `DiscoveredProduct` in `lib/md-strategy.ts:504`. The `?? null` coalescing in Task 1 Step 2 normalizes to the `string | null` shape that `parseChannelSlugs` accepts.
- `p.name`, `p.code`, `p.reason`, `p.monthly_trajectory` (Task 2) — all already present on the strategy's `tier1_products` / `tier2_products` shape per `ProductSelectionOutput` (`lib/md-strategy.ts:1246–1266`).

No type drift.

---

## Out of scope (deferred to future plans)

- **Spec 2 — source-mix ratio control.** Limiting TXD's share of recommendations to ~30–40%. Will likely touch `discoverNewProducts` and the Gemini prompts inside `lib/md-strategy.ts`.
- **Spec 3 — adaptive learning of the mix.** Depends on Spec 2 + new feedback signals.
- **Shared badge module.** Reasonable to extract once Spec 2 introduces a fourth badge kind.
- **Brave API Pro upgrade.** Operational task performed by the user via brave.com/search/api/. Necessary for the TV-channel pills introduced here to actually appear on freshly-cron'd data, but not blocking for the UI work.
