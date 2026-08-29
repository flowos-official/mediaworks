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
