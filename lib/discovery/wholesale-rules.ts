/**
 * Wholesale estimation — blends Japan home-shopping industry baseline
 * margin rates with MediaWorks' own historical data from product_summaries.
 * Ref: spec §5.4.
 *
 * Formula: wholesale = retail × (1 - blended_margin_rate)
 *   blended = 0.6 × baseline + 0.4 × mediaworks (if mediaworks sample ≥ 3)
 *   else: blended = baseline
 */

import { getServiceClient } from "@/lib/supabase";
import type { Confidence, WholesaleEstimate } from "./types";

// Industry baseline margin rates (gross margin) — Japan home shopping averages.
// Keys use broad category prefixes matching product_summaries.category patterns.
const BASELINE_MARGINS: Record<string, number> = {
	美容: 0.55,
	化粧品: 0.55,
	キッチン: 0.45,
	家電: 0.35,
	医療機器: 0.5,
	健康: 0.5,
	防災: 0.4,
	寝具: 0.45,
	アパレル: 0.5,
	ゴルフ: 0.4,
	食品: 0.3,
	宝飾: 0.55,
	雑貨: 0.45,
};

const DEFAULT_BASELINE_MARGIN = 0.42;

function matchBaselineCategory(category: string | null | undefined): number {
	if (!category) return DEFAULT_BASELINE_MARGIN;
	for (const [prefix, margin] of Object.entries(BASELINE_MARGINS)) {
		if (category.includes(prefix)) return margin;
	}
	return DEFAULT_BASELINE_MARGIN;
}

interface MediaWorksStats {
	median: number;
	sampleSize: number;
}

/**
 * Aggregate median margin_rate from product_summaries for a category.
 * Uses fuzzy match (category includes prefix).
 */
async function loadMediaWorksStats(category: string | null | undefined): Promise<MediaWorksStats> {
	if (!category) return { median: 0, sampleSize: 0 };
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("product_summaries")
		.select("margin_rate, category")
		.not("margin_rate", "is", null)
		.limit(2000);
	if (error || !data) return { median: 0, sampleSize: 0 };

	const matched = (data as Array<{ margin_rate: number; category: string | null }>)
		.filter((r) => r.category && r.category.includes(category.slice(0, 4)))
		.map((r) => r.margin_rate)
		.filter((m) => m > 0 && m < 1)
		.sort((a, b) => a - b);

	if (matched.length === 0) return { median: 0, sampleSize: 0 };
	const mid = Math.floor(matched.length / 2);
	const median =
		matched.length % 2 === 0 ? (matched[mid - 1] + matched[mid]) / 2 : matched[mid];
	return { median, sampleSize: matched.length };
}

function confidenceFromSample(sampleSize: number): Confidence {
	if (sampleSize >= 10) return "high";
	if (sampleSize >= 3) return "medium";
	return "low";
}

export async function estimateWholesale(
	retailJpy: number,
	category: string | null | undefined,
): Promise<WholesaleEstimate> {
	const baseline = matchBaselineCategory(category);
	const stats = await loadMediaWorksStats(category);

	let blendedMargin: number;
	let method: WholesaleEstimate["method"];
	if (stats.sampleSize >= 3) {
		blendedMargin = 0.6 * baseline + 0.4 * stats.median;
		method = "blended";
	} else {
		blendedMargin = baseline;
		method = "baseline";
	}

	const cost = Math.round(retailJpy * (1 - blendedMargin));
	return {
		retail_jpy: retailJpy,
		estimated_cost_jpy: cost,
		estimated_margin_rate: Number(blendedMargin.toFixed(3)),
		method,
		sample_size: stats.sampleSize,
		confidence: confidenceFromSample(stats.sampleSize),
	};
}
