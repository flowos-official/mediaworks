import type { ProductBrief } from "./types";

type ScreenplayCustomization = NonNullable<ProductBrief["customization"]>;
export type ScreenplayOffer = Pick<ProductBrief, "price" | "bonuses" | "guarantee">;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function shortText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized ? normalized.slice(0, max) : undefined;
}

function textList(value: unknown, limit: number, max: number): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.map((item) => shortText(item, max))
		.filter((item): item is string => Boolean(item))
		.slice(0, limit);
	return items.length > 0 ? items : undefined;
}

/**
 * Normalize the operator-controlled writing brief at the server boundary.
 * This is shared by manual-product and existing-product creation so neither
 * path can bypass the length/range constraints used by the prompt.
 */
export function sanitizeScreenplayCustomization(value: unknown): ScreenplayCustomization | undefined {
	const input = record(value);
	if (!input) return undefined;

	const output: ScreenplayCustomization = {};
	if (typeof input.runtimeMinutes === "number" && Number.isFinite(input.runtimeMinutes)) {
		output.runtimeMinutes = Math.min(120, Math.max(1, Math.round(input.runtimeMinutes)));
	}

	const targetAudience = shortText(input.targetAudience, 600);
	if (targetAudience) output.targetAudience = targetAudience;
	const keyMessage = shortText(input.keyMessage, 300);
	if (keyMessage) output.keyMessage = keyMessage;

	const mustDemos = textList(input.mustDemos, 12, 300);
	if (mustDemos) output.mustDemos = mustDemos;
	const mustAvoid = textList(input.mustAvoid, 12, 300);
	if (mustAvoid) output.mustAvoid = mustAvoid;

	if (input.tonalAdjust === "calm" || input.tonalAdjust === "neutral" || input.tonalAdjust === "energetic") {
		output.tonalAdjust = input.tonalAdjust;
	}

	if (Array.isArray(input.extraSpeakers)) {
		const extraSpeakers = input.extraSpeakers
			.map((item) => {
				const speaker = record(item);
				if (!speaker) return null;
				const role = shortText(speaker.role, 40)?.replace(/[\[\]]/g, "");
				const description = shortText(speaker.description, 300);
				return role && description ? { role, description } : null;
			})
			.filter((item): item is { role: string; description: string } => Boolean(item))
			.slice(0, 8);
		if (extraSpeakers.length > 0) output.extraSpeakers = extraSpeakers;
	}

	return Object.keys(output).length > 0 ? output : undefined;
}

/** Confirmed commercial terms supplied by the operator immediately before generation. */
export function sanitizeScreenplayOffer(value: unknown): ScreenplayOffer {
	const input = record(value);
	if (!input) return {};
	const output: ScreenplayOffer = {};

	const rawPrice = record(input.price);
	if (rawPrice) {
		const price: NonNullable<ProductBrief["price"]> = {};
		for (const key of ["listJpy", "saleJpy", "shippingJpy"] as const) {
			const amount = rawPrice[key];
			if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
				price[key] = Math.floor(amount);
			}
		}
		if (Object.keys(price).length > 0) output.price = price;
	}

	const bonuses = textList(input.bonuses, 20, 200);
	if (bonuses) output.bonuses = bonuses;
	const guarantee = shortText(input.guarantee, 500);
	if (guarantee) output.guarantee = guarantee;
	return output;
}
