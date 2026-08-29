import type { SeedOptions } from "./queue";

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
