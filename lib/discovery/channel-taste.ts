import { getServiceClient } from "@/lib/supabase";
import { loadCategoryFitWeights } from "@/lib/discovery/competitor-trend-boost";

export interface ChannelTasteProfile {
	channel_slug: string;
	source_tier: 1 | 2 | 3 | 4;
	category_weights: Map<
		string,
		{ raw_share: number; fit_score: number | null; final_weight: number }
	>;
	sample_size: number;
	reasoning: string;
}

const QVC_SHOPCH = new Set(["qvc", "shopch"]);

export async function loadChannelTasteProfile(
	channelSlug: string,
	lookbackDays: number = 30,
): Promise<ChannelTasteProfile> {
	const sb = getServiceClient();
	const sinceIso = new Date(Date.now() - lookbackDays * 86_400_000)
		.toISOString()
		.slice(0, 10);

	// Load fit weights once for this channel scope — passed to all buildProfile call sites.
	const fitWeights = await loadCategoryFitWeights([channelSlug]);

	// Tier 1 — QVC/ShopCh: broadcasts.category direct query
	if (QVC_SHOPCH.has(channelSlug)) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("category")
			.eq("channel", channelSlug)
			.gte("air_date", sinceIso)
			.not("category", "is", null);
		if (error || !data) {
			return emptyProfile(
				channelSlug,
				4,
				`query failed: ${error?.message ?? "no data"}`,
			);
		}
		return buildProfile(
			channelSlug,
			1,
			data.map((r) => r.category as string),
			fitWeights,
			`Tier 1 (broadcasts.category) — ${data.length} rows`,
		);
	}

	// Tier 2 — OA channels: historical_broadcasts.category
	const { data: histRows, error: histErr } = await sb
		.from("historical_broadcasts")
		.select("category")
		.eq("channel", channelSlug)
		.gte("air_date", sinceIso);
	if (histErr) {
		return emptyProfile(
			channelSlug,
			4,
			`historical_broadcasts query failed: ${histErr.message}`,
		);
	}
	if (histRows && histRows.length > 0) {
		const populated = histRows.filter((r) => r.category !== null);
		const nullRate = 1 - populated.length / histRows.length;
		if (nullRate < 0.9) {
			return buildProfile(
				channelSlug,
				2,
				populated.map((r) => r.category as string),
				fitWeights,
				`Tier 2 (historical_broadcasts.category) — ${populated.length}/${histRows.length} rows populated`,
			);
		}
	}

	// Tier 3 — discovered_products fallback
	const { data: discRows, error: discErr } = await sb
		.from("discovered_products")
		.select("category")
		.ilike("tv_channel_source", `%${channelSlug}%`)
		.not("category", "is", null)
		.gte(
			"created_at",
			new Date(Date.now() - lookbackDays * 86_400_000).toISOString(),
		);
	if (discErr || !discRows || discRows.length === 0) {
		return emptyProfile(channelSlug, 4, `Tier 3 fallback empty (discovered_products)`);
	}
	return buildProfile(
		channelSlug,
		3,
		discRows.map((r) => r.category as string),
		fitWeights,
		`Tier 3 (discovered_products fallback) — ${discRows.length} rows`,
	);
}

export async function loadChannelTasteProfiles(
	channelSlugs: string[],
	lookbackDays: number = 30,
): Promise<Map<string, ChannelTasteProfile>> {
	const profiles = await Promise.all(
		channelSlugs.map((slug) => loadChannelTasteProfile(slug, lookbackDays)),
	);
	return new Map(profiles.map((p) => [p.channel_slug, p]));
}

function buildProfile(
	channelSlug: string,
	sourceTier: 1 | 2 | 3,
	categories: string[],
	fitWeights: Map<string, { avg: number; n: number }>,
	reasoning: string,
): ChannelTasteProfile {
	const counts = new Map<string, number>();
	for (const c of categories) {
		counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	const total = categories.length || 1;
	const weights = new Map<
		string,
		{ raw_share: number; fit_score: number | null; final_weight: number }
	>();
	for (const [cat, count] of counts) {
		const raw_share = count / total;
		const fit = fitWeights.get(cat) ?? null;
		const fit_score = fit?.avg ?? null;
		// Per spec §5-2: final_weight = raw_share × (fit_score/50, default 1.0)
		const multiplier = fit_score !== null ? fit_score / 50 : 1.0;
		const final_weight = raw_share * multiplier;
		weights.set(cat, { raw_share, fit_score, final_weight });
	}
	return {
		channel_slug: channelSlug,
		source_tier: sourceTier,
		category_weights: weights,
		sample_size: categories.length,
		reasoning,
	};
}

function emptyProfile(
	channelSlug: string,
	sourceTier: 4,
	reasoning: string,
): ChannelTasteProfile {
	return {
		channel_slug: channelSlug,
		source_tier: sourceTier,
		category_weights: new Map(),
		sample_size: 0,
		reasoning,
	};
}
