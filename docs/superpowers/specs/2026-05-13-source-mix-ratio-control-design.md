# Source-Mix Ratio Control Design (Spec 2)

**Date:** 2026-05-13
**Status:** Draft — not yet implemented. Captured for future work.
**Predecessor:** Spec 1 — product source badges (`2026-05-13-product-source-badges-design.md`, merged)
**Successor:** Spec 3 — adaptive learning of the source mix

## Problem

The strategy result currently leans heavily on TXD-catalog products (the user's own past-selling SKUs sourced from `product_summaries`). In a sample inspection on 2026-05-13, tier1 + tier2 recommendations were dominated by TXD items while the freshly-discovered (Rakuten / TV-channel / Brave) pool contributed a minority. The user has stated the long-term mix they want is closer to **TXD ≈ 30–40%, fresh discoveries ≈ 60–70%**. Today there is no parameter that controls this ratio; the AI prompt and per-stage target counts implicitly let TXD dominate.

The user's reasoning: past-selling TXD products are useful as a base signal (they sold well once) but they're not a forecast of what will sell *next*. Over-weighting them is essentially "more of the same"; for category expansion the fresh pool is the differentiator.

## Goals

1. Provide a single tunable knob — a target fraction of TXD in the user-visible recommended set — and have the pipeline respect it.
2. Default to `TXD_TARGET_FRACTION = 0.35` (midpoint of the 30–40% range). Keep it env-overridable so we can tune without code changes.
3. Preserve the existing two-section UI (channel-product matrix for TXD, DiscoveredProductsHero for fresh). Spec 1's badges already let the user see source mix visually.
4. Fail open: when the pipeline cannot fill the fresh side to the target ratio (e.g., Brave API throttled, no pool hits), accept a temporarily TXD-heavier output rather than blocking the whole result.

## Non-goals

- **Learning the right ratio.** That is Spec 3.
- **Per-channel ratios** (e.g., different TXD share for `ホームショッピング` vs `ライブコマース`). Single global ratio for v1.
- **Per-category ratios.** Same — single global for v1. Spec 3 can introduce both axes.
- **Replacing the AI scoring.** The ratio is a quota gate, not a scoring change. Gemini still scores within its bucket.

## Open questions (need decision before implementation)

1. **Where to enforce the ratio?** Three plausible cut points:
   - (a) **At the Gemini prompt** for `productSelection`: tell the model "you have N total slots, only K should be TXD-catalog, the rest must be fresh discoveries." Pro: single source of truth. Con: hard to verify the AI obeys; ratio drifts.
   - (b) **At the orchestrator** post-curate: enforce a hard cap on TXD count after both `productSelection` and `discoverNewProducts` produce their outputs. Trim or pad. Pro: deterministic. Con: may drop high-scoring TXD items or accept low-scoring fresh items.
   - (c) **At the input** to `discoverNewProducts`: request more fresh products up-front (e.g., target=20 fresh instead of 12) so the natural mix shifts. Pro: doesn't touch existing logic. Con: more API quota usage; doesn't guarantee final ratio.
   
   Recommendation: start with (b). It's the only point where the actual final ratio is observable and controllable.

2. **What counts as TXD?** Today, every item in `channel_product_matrix.tier1_products / tier2_products` is TXD by construction (Spec 1 §1). DiscoveredProductsHero items are fresh. So the count is just `len(matrix.tier1)+len(matrix.tier2)` vs `len(discovered_new_products)`. Confirm before implementing — if Spec 2 wants to also count Rakuten items differently, the definition needs widening.

3. **What does "the user-visible recommended set" mean?** Two interpretations:
   - **Stat-level**: only the *visible* products on the result page (tier1 + tier2 + discovered_new). Exclusions are not counted.
   - **Decision-level**: every product the AI considered, weighted by how prominently it's displayed.
   
   Recommendation: stat-level. The badges in Spec 1 let the user visually verify "I'm seeing 35% TXD" — that's what they care about.

4. **What happens when fresh pool returns too few products?** E.g., Brave throttled, no matches. Two options:
   - **Pad with more TXD** (accept temporary TXD-heavy ratio with a warning in the saved strategy).
   - **Shrink total count** (return fewer products overall, preserve ratio).
   
   Recommendation: pad. Users prefer "more recommendations, slightly biased" over "fewer recommendations".

## Decision summary (provisional)

Enforce ratio at the **orchestrator** post-curate (option 1.b). Compute `target_total = current visible total`, `target_txd = floor(target_total * TXD_TARGET_FRACTION)`. If `actual_txd > target_txd`:
- Trim lower-ranked tier2 items first (keep tier1 sacred). Specifically, drop the tail of tier2 by Gemini's implicit ranking (assume current array order is ranked) until `actual_txd ≤ target_txd`, or until tier2 is empty.
- If still over after tier2 is empty, trim the tail of tier1.

If `actual_txd ≤ target_txd` and `actual_fresh < target_fresh`:
- Accept the shortfall (pad path). Log a structured warning so it shows up in `verify-discovery-run` style diagnostics.

A new env var `TXD_TARGET_FRACTION` (default `0.35`) gates this behavior. `TXD_TARGET_FRACTION=1.0` disables the cap (preserves current behavior). `TXD_TARGET_FRACTION=0.0` would force all-fresh, useful as a stress test.

## Design (provisional outline — fill in during writing-plans)

### §1. Configuration

```ts
const TXD_TARGET_FRACTION = Number(process.env.TXD_TARGET_FRACTION ?? 0.35);
```

Add to `lib/md-strategy.ts` near the other env-tuned constants.

### §2. Ratio enforcer

In `lib/md-strategy.ts`, after the orchestrator finishes both `productSelection` and `discoverNewProducts`, call a new helper:

```ts
enforceTxdFraction(productSelection, discoveredNewProducts, TXD_TARGET_FRACTION)
  → mutates `productSelection.channel_product_matrix[].tier1_products` / `.tier2_products`
  → returns metadata: { actual_fraction, trimmed_count, warnings }
```

Trim policy:
- Drop tier2 tail first (channel-by-channel, round-robin) until `actual_txd ≤ target_txd`.
- If still over, drop tier1 tail (channel-by-channel, round-robin).
- Never drop tier1 below 1 per channel (preserve the "primary recommendation" guarantee).

### §3. Logging and observability

- Add `txd_fraction_metadata` to the saved `md_strategies` row (new column, jsonb). Stores `{ target, actual, trimmed_count, padded_count, warnings }` so the post-mortem on each strategy is reproducible.
- `scripts/verify-discovery-run.ts` (or a new `verify-strategy-run.ts`) prints the actual ratio for the last N strategies.

### §4. UI hooks

The Spec 1 badges already make the ratio visible. No UI change required for Spec 2.

Optional: a small banner above the channel-product matrix saying `TXD: 35% (target) · 33% (actual)` would be useful for transparency, but it's not strictly necessary.

### §5. Migration

- New env var (no-op default keeps current behavior at fraction=0.35; if you want fully off, set `TXD_TARGET_FRACTION=1.0`).
- New column `md_strategies.txd_fraction_metadata jsonb null` — additive migration, safe.

### §6. Risks

- **Trimming high-quality TXD items.** If the Gemini-ranked tier2 has a strong product at position 5 and the cap forces trimming positions 4+, we lose it. Mitigation: surface trimmed items as "considered but capped" in the saved strategy, so the user can manually rescue them.
- **Fresh pool quality is uneven.** Brave site-search returns sparse data (title + url only); Rakuten returns rich data. The ratio enforces by *count*, not *quality*. Mitigation: combine with a minimum-score threshold for fresh items (drop fresh below score 30) before counting toward the fraction.
- **Brave quota or function-timeout issues** (the same problem identified in Spec 1's Brave-quota incident) can cause `discoveredNewProducts` to be near-empty. With the pad-not-shrink policy, we silently accept a TXD-heavy result. Mitigation: emit a structured warning when actual fraction deviates from target by > 0.15.

## Verification

Without a sales-outcome signal, the only short-term verification is structural:

- For a strategy run with default settings, the actual TXD fraction stays within `[target − 0.1, target + 0.1]` for typical inputs.
- For `TXD_TARGET_FRACTION=1.0`, behavior is identical to today's output.
- For `TXD_TARGET_FRACTION=0.0`, the matrix is empty / minimal and DiscoveredProductsHero is full.

Long-term verification requires Spec 3's feedback signals.

## Out of scope (deferred)

- Per-category TXD ratio (Spec 3).
- Adaptive ratio that responds to feedback / outcomes (Spec 3).
- Per-channel ratio (e.g. "Amazon Japan" vs "TikTok Shop") — meaningful but adds complexity; revisit when there's evidence the global ratio is too coarse.

## Implementation effort estimate

- 1 helper function (`enforceTxdFraction`) + tests
- 1 migration (txd_fraction_metadata column)
- 1 small env-config addition
- 1 verify script extension

Roughly **half a day** of work. The harder part is deciding the open questions above; once those are answered the code is straightforward.
