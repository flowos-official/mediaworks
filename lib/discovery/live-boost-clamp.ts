/**
 * Live-commerce post-boost total-delta clamp.
 *
 * After the four boost layers (L1 ROOM / L2 Rakuten LIVE archive /
 * L3 creator content / L4 hashtag) each apply their own additive boost
 * with a per-layer cap of +5, a single candidate can in principle
 * accumulate up to +20. The clamp enforces a smaller total cap (default
 * +15) so no candidate can rise purely through stacked boosts. Pure
 * function — no IO.
 *
 * The clamp is keyed on a baseline tvFitScore snapshot taken right
 * after curate but before any boost layer runs. Candidates absent from
 * the baseline map are left untouched (defensive — should not happen
 * in normal flow).
 */
import type { Candidate } from "./types";

/**
 * Mutates each candidate in place: when its tvFitScore minus the
 * baseline exceeds `cap`, sets tvFitScore to baseline + cap (clamped
 * to 100) and appends a `[合算cap+<cap>]` annotation to tvFitReason.
 *
 * Returns the number of candidates that were clamped.
 */
export function clampLiveBoosts(
	candidates: Candidate[],
	baselineByUrl: Map<string, number>,
	cap: number,
): number {
	let clamped = 0;
	for (const c of candidates) {
		const baseline = baselineByUrl.get(c.productUrl);
		if (baseline === undefined) continue;
		const delta = c.tvFitScore - baseline;
		if (delta <= cap) continue;
		c.tvFitScore = Math.min(100, baseline + cap);
		c.tvFitReason = `${c.tvFitReason} [合算cap+${cap}]`.slice(0, 200);
		clamped += 1;
	}
	return clamped;
}
