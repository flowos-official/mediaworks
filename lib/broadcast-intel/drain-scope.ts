import type { SeedOptions } from "./queue";

/** Parse once before reset, seeding, and draining consume the operator scope. */
export function parseDrainCategory(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const category = raw.trim();
	if (!category) throw new Error("--category must be a nonblank value");
	return category;
}

/**
 * Preserve an operator's explicit scope, while allowing the absent-category
 * drain path to use the same balanced queue selection as cron.
 */
export function buildDrainAnalysisScope(
	category: string | undefined,
	channel: "qvc" | "shopch" | undefined,
): Pick<SeedOptions, "category" | "channel"> {
	return {
		...(category !== undefined ? { category } : {}),
		...(channel ? { channel } : {}),
	};
}

/**
 * `--reset` requires an explicit scope.
 *
 * Making `--category` optional was right for seeding — an unscoped drain now
 * uses the same category-balanced selection as the cron. It was not right for
 * reset. `resetAnalysisError` has no `.limit()`, so the previously mandatory
 * `--category` was the only thing bounding it; without one, the habitual
 * `--reset=gemini_error --limit=40` silently requeues every matching slot on
 * both channels across every category and clears their attempt counters, and
 * the cron then spends S3 egress and Gemini quota re-running all of it.
 *
 * Seeding stays unscoped. Only the destructive verb asks for a target.
 */
export function assertResettableScope(
	scope: Pick<SeedOptions, "category" | "channel">,
	errorCode: string,
): void {
	if (scope.category !== undefined || scope.channel !== undefined) return;
	throw new Error(
		`--reset=${errorCode} needs --category or --channel: an unscoped reset requeues every matching slot on both channels and resets their attempt counters.`,
	);
}
