/**
 * Pure weighting for the selection-outcome learning loop. No I/O so it is
 * unit-testable and `tsx`-importable (deliberately no `import "server-only"`).
 * Ref: docs/superpowers/specs/2026-05-29-selection-outcome-loop-design.md §2.
 */

export type SelectionOutcome =
	| "selected"
	| "sourcing"
	| "scheduled"
	| "aired"
	| "dropped";

export type UserAction = "sourced" | "interested" | "rejected" | "duplicate";

export const OUTCOME_WEIGHTS: Record<SelectionOutcome, number> = {
	aired: Number(process.env.LEARNING_OUTCOME_W_AIRED ?? 5),
	scheduled: Number(process.env.LEARNING_OUTCOME_W_SCHEDULED ?? 3),
	sourcing: Number(process.env.LEARNING_OUTCOME_W_SOURCING ?? 2),
	selected: Number(process.env.LEARNING_OUTCOME_W_SELECTED ?? 1),
	dropped: Number(process.env.LEARNING_OUTCOME_W_DROPPED ?? -1),
};

const DEFAULT_MIN_SAMPLES = Number(process.env.DISCOVERY_CATEGORY_MIN_SAMPLES ?? 5);
const DEFAULT_CAP = Number(process.env.LEARNING_CATEGORY_WEIGHT_CAP ?? 3);

export function outcomeWeight(o: SelectionOutcome | null | undefined): number {
	if (!o) return 0;
	return OUTCOME_WEIGHTS[o] ?? 0;
}

export function userActionWeight(a: UserAction | null | undefined): number {
	return a === "sourced" || a === "interested" ? 1 : 0;
}

export interface CohortRow {
	category: string | null;
	selection_outcome: SelectionOutcome | null;
	user_action: UserAction | null;
}

/**
 * category → clamped weight. Per product: rowSuccess = selection_outcome is
 * present ? outcomeWeight(it) : userActionWeight(user_action) — a MAX-style
 * precedence, never a sum, so there is no double-count. deep_dive clicks fold
 * in at 0.5 each. Categories below `minSamples` shown get the neutral 0.5.
 */
export function aggregateCategoryWeights(
	cohort: CohortRow[],
	deepDiveByCategory: Record<string, number>,
	opts: { minSamples?: number; cap?: number } = {},
): Record<string, number> {
	const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
	const cap = opts.cap ?? DEFAULT_CAP;

	const stat = new Map<string, { success: number; shown: number }>();
	for (const r of cohort) {
		const cat = r.category;
		if (!cat) continue;
		const s = stat.get(cat) ?? { success: 0, shown: 0 };
		s.shown += 1;
		s.success +=
			r.selection_outcome != null
				? outcomeWeight(r.selection_outcome)
				: userActionWeight(r.user_action);
		stat.set(cat, s);
	}
	for (const [cat, n] of Object.entries(deepDiveByCategory)) {
		const s = stat.get(cat) ?? { success: 0, shown: 0 };
		s.success += 0.5 * n;
		stat.set(cat, s);
	}

	const weights: Record<string, number> = {};
	for (const [cat, { success, shown }] of stat) {
		if (shown < minSamples) {
			weights[cat] = 0.5;
			continue;
		}
		const raw = success / shown;
		weights[cat] = Number(Math.max(0, Math.min(cap, raw)).toFixed(3));
	}
	return weights;
}
