/**
 * Phase 3-D: category-frequency transparency.
 *
 * "Why do medical devices keep appearing?" → because category X represented
 * Y% of competitor broadcasts in the lookback window. This helper computes
 * the full per-category distribution so the discovery UI can render a
 * "X% historical share" badge next to candidates / above the result list.
 *
 * Source: `broadcasts` (QVC + ShopCh) where category is populated. The 8 OA
 * channels in `historical_broadcasts` join in only after their per-channel
 * whitelist exists; for now their categories are NULL and excluded.
 *
 * Fail-open: any DB error yields an empty list.
 */
import { getServiceClient } from "@/lib/supabase";
import { getRuntimeMarketCountry } from "@/lib/market/runtime-market";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const HISTORICAL_LOOKBACK_DAYS = envInt("HISTORICAL_LOOKBACK_DAYS", 30);

export interface CategoryShare {
	category: string;
	count: number;
	share: number; // 0..100, rounded to 1 decimal
}

export interface CategoryDistribution {
	lookbackDays: number;
	totalSlots: number;
	categories: CategoryShare[];
}

export async function loadCategoryDistribution(
	topN = 6,
): Promise<CategoryDistribution> {
	const sb = getServiceClient();
	const cutoff = new Date(
		Date.now() - HISTORICAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
	)
		.toISOString()
		.slice(0, 10);

	const [broadcasts, historical] = await Promise.all([
		sb
			.from("broadcasts")
			.select("category")
			.eq("country", getRuntimeMarketCountry())
			.gte("air_date", cutoff)
			.not("category", "is", null),
		sb
			.from("historical_broadcasts")
			.select("category")
			.eq("country", getRuntimeMarketCountry())
			.gte("air_date", cutoff)
			.not("category", "is", null),
	]);

	if (broadcasts.error) {
		console.warn(
			"[category-distribution] broadcasts lookup failed:",
			broadcasts.error.message,
		);
	}
	if (historical.error) {
		console.warn(
			"[category-distribution] historical lookup failed:",
			historical.error.message,
		);
	}

	const rows = [
		...((broadcasts.data ?? []) as { category: string | null }[]),
		...((historical.data ?? []) as { category: string | null }[]),
	];

	const freq = new Map<string, number>();
	let total = 0;
	for (const row of rows) {
		if (!row.category) continue;
		freq.set(row.category, (freq.get(row.category) ?? 0) + 1);
		total += 1;
	}

	if (total === 0) {
		return {
			lookbackDays: HISTORICAL_LOOKBACK_DAYS,
			totalSlots: 0,
			categories: [],
		};
	}

	const categories = [...freq.entries()]
		.map(([category, count]) => ({
			category,
			count,
			share: Math.round((count / total) * 1000) / 10,
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, topN);

	return {
		lookbackDays: HISTORICAL_LOOKBACK_DAYS,
		totalSlots: total,
		categories,
	};
}
