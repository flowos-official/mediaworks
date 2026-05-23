// lib/research/competitor-context.ts
import { normalizeCategory } from "@/lib/discovery/category-normalize";
import { getServiceClient } from "@/lib/supabase";

export interface RecentAiring {
	channel: string;
	program_title: string | null;
	brand_name: string | null;
	air_date: string;
	start_time: string | null;
}

export interface OperatorFitSample {
	product_name: string;
	fit_score: number;
	summary: string | null;
}

export interface BroadcastContext {
	recentAirings: RecentAiring[];   // QVC + ShopCh, last 60d
	oaAirings: RecentAiring[];        // historical_broadcasts, last 60d
	operatorFit: {
		avg: number | null;
		count: number;
		top3: OperatorFitSample[];
	};
}

const LOOKBACK_DAYS = 60;
const FIT_LOOKBACK_DAYS = 90;

function isoDaysAgo(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

export function uniqueCategoryCandidates(
	rawCategory: string | null | undefined,
	normalizedCategories: string[],
): string[] {
	const out: string[] = [];
	for (const value of [rawCategory, ...normalizedCategories]) {
		const trimmed = typeof value === "string" ? value.trim() : "";
		if (!trimmed || out.includes(trimmed)) continue;
		out.push(trimmed);
	}
	return out;
}

/**
 * Loads competitor airing + operator fit context for a category.
 * Returns null if category is null/empty (no meaningful query). All errors
 * are swallowed (logged) — the report still generates without this context.
 */
export async function loadBroadcastContext(
	category: string | null | undefined,
): Promise<BroadcastContext | null> {
	if (!category || category.trim().length === 0) return null;

	const sb = getServiceClient();
	const sinceBroadcasts = isoDaysAgo(LOOKBACK_DAYS);
	const sinceFit = isoDaysAgo(FIT_LOOKBACK_DAYS);

	try {
		const normalized = await normalizeCategory(sb, category);
		const categoryCandidates = uniqueCategoryCandidates(category, normalized);
		if (categoryCandidates.length === 0) return null;

		const recentQuery =
			categoryCandidates.length === 1
				? sb
						.from("broadcasts")
						.select("channel, program_title, brand_name, air_date, start_time")
						.eq("category", categoryCandidates[0])
						.gte("air_date", sinceBroadcasts)
						.order("air_date", { ascending: false })
						.limit(10)
				: sb
						.from("broadcasts")
						.select("channel, program_title, brand_name, air_date, start_time")
						.in("category", categoryCandidates)
						.gte("air_date", sinceBroadcasts)
						.order("air_date", { ascending: false })
						.limit(10);
		const oaQuery =
			categoryCandidates.length === 1
				? sb
						.from("historical_broadcasts")
						.select("channel, product_name, air_date, start_time")
						.eq("category", categoryCandidates[0])
						.gte("air_date", sinceBroadcasts)
						.order("air_date", { ascending: false })
						.limit(10)
				: sb
						.from("historical_broadcasts")
						.select("channel, product_name, air_date, start_time")
						.in("category", categoryCandidates)
						.gte("air_date", sinceBroadcasts)
						.order("air_date", { ascending: false })
						.limit(10);
		const fitQuery =
			categoryCandidates.length === 1
				? sb
						.from("competitor_fit_analyses")
						.select("product_name, fit_score, summary")
						.eq("category", categoryCandidates[0])
						.gte("created_at", sinceFit)
						.order("fit_score", { ascending: false })
						.limit(20)
				: sb
						.from("competitor_fit_analyses")
						.select("product_name, fit_score, summary")
						.in("category", categoryCandidates)
						.gte("created_at", sinceFit)
						.order("fit_score", { ascending: false })
						.limit(20);

		const [recentRes, oaRes, fitRes] = await Promise.all([
			recentQuery,
			oaQuery,
			fitQuery,
		]);

		const recentAirings: RecentAiring[] = (recentRes.data ?? []).map((r) => ({
			channel: r.channel,
			program_title: r.program_title,
			brand_name: r.brand_name,
			air_date: r.air_date,
			start_time: r.start_time,
		}));

		const oaAirings: RecentAiring[] = (oaRes.data ?? []).map((r) => ({
			channel: r.channel,
			program_title: r.product_name,  // historical_broadcasts uses product_name as program label
			brand_name: null,
			air_date: r.air_date,
			start_time: r.start_time,
		}));

		const fitRows = fitRes.data ?? [];
		const nonNullFitRows = fitRows.filter((r) => r.fit_score != null);
		const avg =
			nonNullFitRows.length > 0
				? Math.round(
						nonNullFitRows.reduce((s, r) => s + (r.fit_score as number), 0) /
							nonNullFitRows.length,
					)
				: null;
		const top3: OperatorFitSample[] = nonNullFitRows.slice(0, 3).map((r) => ({
			product_name: r.product_name ?? "",
			fit_score: r.fit_score as number,
			summary: r.summary,
		}));

		return {
			recentAirings,
			oaAirings,
			operatorFit: { avg, count: nonNullFitRows.length, top3 },
		};
	} catch (err) {
		console.warn("[competitor-context] query failed:", err);
		return null;
	}
}

/**
 * Renders the BroadcastContext as a prompt section to inject into Gemini.
 * Returns empty string if context is null/empty — caller can concat unconditionally.
 */
export function formatBroadcastContextPrompt(ctx: BroadcastContext | null): string {
	if (!ctx) return "";
	const totalAirings = ctx.recentAirings.length + ctx.oaAirings.length;
	if (totalAirings === 0 && ctx.operatorFit.count === 0) return "";

	const brandLine =
		ctx.recentAirings.length > 0
			? Array.from(
					new Set(ctx.recentAirings.map((a) => a.brand_name).filter(Boolean)),
				)
					.slice(0, 5)
					.join(", ") || "(brand未取得)"
			: "(放送なし)";

	const programLine =
		ctx.recentAirings.length > 0
			? ctx.recentAirings
					.slice(0, 5)
					.map((a) => `${a.channel}: ${a.program_title ?? "(no title)"}`)
					.join(" / ")
			: "(放送なし)";

	const fitLine =
		ctx.operatorFit.avg !== null
			? `平均適合度 ${ctx.operatorFit.avg}/100 (n=${ctx.operatorFit.count}, 直近${FIT_LOOKBACK_DAYS}日)`
			: "運営者評価データなし";

	const fitSamples = ctx.operatorFit.top3
		.map((s) => `- ${s.product_name} (${s.fit_score}点): ${s.summary ?? ""}`)
		.join("\n");

	return `
## 実測 競合データ (社内DB 由来)
直近${LOOKBACK_DAYS}日のQVC + ShopCh + OA 7局における同カテゴリ放送:
- 総スロット数: QVC/ShopCh ${ctx.recentAirings.length}件 + OA ${ctx.oaAirings.length}件
- 上位ブランド: ${brandLine}
- 代表番組: ${programLine}

運営者キュレーション (competitor_fit_analyses):
${fitLine}
${fitSamples}

以下の Competitor / Seasonality セクションでは、上記の実測データを優先して引用し、Web検索結果は補助としてのみ使用すること。
`;
}

export const __test = {
	uniqueCategoryCandidates,
};
