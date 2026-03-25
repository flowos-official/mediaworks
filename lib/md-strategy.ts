import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServiceClient } from "@/lib/supabase";
import type {
	ProductSummary,
	CategorySummary,
	AnnualSummary,
	MonthlySummary,
	ProductDetail,
	SalesWeeklyTotal,
} from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

async function callGemini(prompt: string): Promise<string> {
	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
	const result = await model.generateContent(prompt);
	return result.response.text().trim();
}

function parseJSON<T>(raw: string): T {
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) throw new Error("Failed to parse JSON from Gemini response");
	return JSON.parse(match[0]) as T;
}

// ---------------------------------------------------------------------------
// Strategy Context — all data needed by skills
// ---------------------------------------------------------------------------

export interface EnrichedProduct {
	code: string;
	name: string;
	category: string | null;
	totalRevenue: number;
	totalProfit: number;
	totalQuantity: number;
	marginRate: number;
	avgWeeklyQty: number;
	weekCount: number;
	// From product_details
	costPrice: number | null;
	wholesaleRate: number | null;
	supplier: string | null;
	manufacturer: string | null;
	manufacturerCountry: string | null;
	salesChannels: { tv: boolean; ec: boolean; paper: boolean; other: boolean } | null;
	skus: Array<{ name: string; color: string; size: string; price_incl: number | null }> | null;
	// Monthly trend
	monthlyTrend: Array<{ month: string; revenue: number; quantity: number; profit: number }>;
	// From research_results (if exists)
	research: {
		marketabilityScore: number;
		demographics: { age_group: string; gender: string; interests: string[] };
		seasonality: Record<string, number>;
		competitors: Array<{ name: string; price: string; platform: string; key_difference: string }>;
		distributionChannels: Array<{ channel_name: string; fit_score: number; reason: string }>;
		marketingStrategy: Array<{ strategy_name: string; type: string; efficiency_score: number }>;
	} | null;
}

export interface StrategyContext {
	annualMetrics: {
		totalRevenue: number;
		totalProfit: number;
		marginRate: number;
		weekCount: number;
		productCount: number;
	};
	categoryBreakdown: Array<{
		category: string;
		revenue: number;
		quantity: number;
		profit: number;
		marginRate: number;
		productCount: number;
	}>;
	products: EnrichedProduct[];
	weeklyTrends: Array<{ weekStart: string; revenue: number; profit: number; quantity: number }>;
	userGoal?: string;
}

// ---------------------------------------------------------------------------
// Fetch all data needed for strategy generation
// ---------------------------------------------------------------------------

export async function fetchStrategyContext(userGoal?: string): Promise<StrategyContext> {
	const supabase = getServiceClient();

	// Phase 1: Parallel fetch from all tables
	const [productResult, categoryResult, annualResult, weeklyTotalResult] = await Promise.all([
		supabase.from("product_summaries").select("*").in("year", [2025, 2026]).order("total_revenue", { ascending: false }),
		supabase.from("category_summaries").select("*").in("year", [2025, 2026]),
		supabase.from("annual_summaries").select("*").in("year", [2025, 2026]),
		supabase.from("sales_weekly_totals").select("*").order("week_start", { ascending: false }).limit(52),
	]);

	if (productResult.error) throw new Error(`product_summaries: ${productResult.error.message}`);
	if (categoryResult.error) throw new Error(`category_summaries: ${categoryResult.error.message}`);
	if (annualResult.error) throw new Error(`annual_summaries: ${annualResult.error.message}`);

	// Merge product summaries across years
	const productMap: Record<string, {
		code: string; name: string; category: string | null;
		totalRevenue: number; totalProfit: number; totalQuantity: number; weekCount: number;
	}> = {};
	for (const row of (productResult.data ?? []) as ProductSummary[]) {
		const key = row.product_code;
		if (!productMap[key]) {
			productMap[key] = { code: row.product_code, name: row.product_name, category: row.category, totalRevenue: 0, totalProfit: 0, totalQuantity: 0, weekCount: 0 };
		}
		productMap[key].totalRevenue += row.total_revenue ?? 0;
		productMap[key].totalProfit += row.total_profit ?? 0;
		productMap[key].totalQuantity += row.total_quantity ?? 0;
		productMap[key].weekCount += row.week_count ?? 0;
	}

	const sortedProducts = Object.values(productMap)
		.map((p) => ({ ...p, marginRate: p.totalRevenue > 0 ? Math.round((p.totalProfit / p.totalRevenue) * 10000) / 100 : 0, avgWeeklyQty: p.weekCount > 0 ? Math.round(p.totalQuantity / p.weekCount) : 0 }))
		.sort((a, b) => b.totalRevenue - a.totalRevenue);

	const top30Codes = sortedProducts.slice(0, 30).map((p) => p.code);

	// Phase 2: Enrichment queries for top 30 products
	const [monthlyResult, detailResult, researchResult] = await Promise.all([
		supabase.from("monthly_summaries").select("*").in("product_code", top30Codes),
		supabase.from("product_details").select("*").in("product_code", top30Codes),
		supabase.from("research_results").select("*"),
	]);

	// Build monthly trend map
	const monthlyMap: Record<string, MonthlySummary[]> = {};
	for (const row of (monthlyResult.data ?? []) as MonthlySummary[]) {
		if (!monthlyMap[row.product_code]) monthlyMap[row.product_code] = [];
		monthlyMap[row.product_code].push(row);
	}

	// Build detail map
	const detailMap: Record<string, ProductDetail> = {};
	for (const row of (detailResult.data ?? []) as ProductDetail[]) {
		detailMap[row.product_code] = row;
	}

	// Build research map (product_id based — match via name)
	const researchList = (researchResult.data ?? []) as Array<{
		product_id: string;
		marketability_score: number;
		demographics: { age_group: string; gender: string; interests: string[] };
		seasonality: Record<string, number>;
		raw_json: Record<string, unknown>;
	}>;

	// Merge category summaries across years
	const catMap: Record<string, { revenue: number; quantity: number; profit: number; productCount: number }> = {};
	for (const c of (categoryResult.data ?? []) as CategorySummary[]) {
		if (!catMap[c.category]) catMap[c.category] = { revenue: 0, quantity: 0, profit: 0, productCount: 0 };
		catMap[c.category].revenue += c.total_revenue ?? 0;
		catMap[c.category].quantity += c.total_quantity ?? 0;
		catMap[c.category].profit += c.total_profit ?? 0;
		catMap[c.category].productCount += c.product_count ?? 0;
	}

	const categoryBreakdown = Object.entries(catMap)
		.map(([category, d]) => ({
			category,
			...d,
			marginRate: d.revenue > 0 ? Math.round((d.profit / d.revenue) * 10000) / 100 : 0,
		}))
		.sort((a, b) => b.revenue - a.revenue);

	// Annual totals
	const annuals = (annualResult.data ?? []) as AnnualSummary[];
	const totalRevenue = annuals.reduce((s, a) => s + (a.total_revenue ?? 0), 0);
	const totalProfit = annuals.reduce((s, a) => s + (a.total_profit ?? 0), 0);
	const weekCount = annuals.reduce((s, a) => s + (a.week_count ?? 0), 0);
	const productCount = annuals.reduce((s, a) => s + (a.product_count ?? 0), 0);

	// Enrich top 30 products
	const enrichedProducts: EnrichedProduct[] = sortedProducts.slice(0, 30).map((p) => {
		const detail = detailMap[p.code];
		const monthly = (monthlyMap[p.code] ?? []).sort((a, b) => a.year_month.localeCompare(b.year_month));

		// Try to find research result for this product (search raw_json for matching name)
		const researchMatch = researchList.find((r) => {
			const rawName = (r.raw_json as Record<string, unknown>)?.product_name as string | undefined;
			return rawName && p.name.includes(rawName.slice(0, 10));
		});

		let research: EnrichedProduct["research"] = null;
		if (researchMatch) {
			const raw = researchMatch.raw_json as Record<string, unknown>;
			research = {
				marketabilityScore: researchMatch.marketability_score ?? 0,
				demographics: researchMatch.demographics ?? { age_group: "", gender: "", interests: [] },
				seasonality: researchMatch.seasonality ?? {},
				competitors: (raw.competitor_analysis as Array<{ name: string; price: string; platform: string; key_difference: string }>) ?? [],
				distributionChannels: (raw.distribution_channels as Array<{ channel_name: string; fit_score: number; reason: string }>) ?? [],
				marketingStrategy: (raw.marketing_strategy as Array<{ strategy_name: string; type: string; efficiency_score: number }>) ?? [],
			};
		}

		return {
			code: p.code,
			name: p.name,
			category: p.category,
			totalRevenue: p.totalRevenue,
			totalProfit: p.totalProfit,
			totalQuantity: p.totalQuantity,
			marginRate: p.marginRate,
			avgWeeklyQty: p.avgWeeklyQty,
			weekCount: p.weekCount,
			costPrice: detail?.cost_price ?? null,
			wholesaleRate: detail?.wholesale_rate ?? null,
			supplier: detail?.supplier ?? null,
			manufacturer: detail?.manufacturer ?? null,
			manufacturerCountry: detail?.manufacturer_country ?? null,
			salesChannels: detail?.sales_channels ?? null,
			skus: detail?.skus?.map((s) => ({ name: s.name, color: s.color, size: s.size, price_incl: s.price_incl })) ?? null,
			monthlyTrend: monthly.map((m) => ({ month: m.year_month, revenue: m.revenue, quantity: m.quantity, profit: m.profit })),
			research,
		};
	});

	// Weekly trends
	const weeklyTrends = ((weeklyTotalResult.data ?? []) as SalesWeeklyTotal[])
		.map((w) => ({ weekStart: w.week_start, revenue: w.total_revenue, profit: w.total_gross_profit, quantity: w.total_quantity }))
		.reverse();

	return {
		annualMetrics: {
			totalRevenue,
			totalProfit,
			marginRate: totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0,
			weekCount,
			productCount,
		},
		categoryBreakdown,
		products: enrichedProducts,
		weeklyTrends,
		userGoal,
	};
}

// ---------------------------------------------------------------------------
// Skill Output Types
// ---------------------------------------------------------------------------

export interface ProductSelectionOutput {
	channel_product_matrix: Array<{
		channel: string;
		tier1_products: Array<{
			code: string;
			name: string;
			reason: string;
			monthly_trajectory: "growing" | "stable" | "declining";
			margin_headroom: string;
		}>;
		tier2_products: Array<{
			code: string;
			name: string;
			reason: string;
		}>;
		exclusions: Array<{
			code: string;
			name: string;
			reason: string;
		}>;
	}>;
	portfolio_strategy: string;
}

export interface ChannelStrategyOutput {
	channels: Array<{
		name: string;
		priority: "immediate" | "3month" | "6month" | "12month";
		fit_score: number;
		market_size: string;
		entry_requirements: {
			account_type: string;
			required_documents: string[];
			setup_timeline: string;
			initial_costs: Array<{ item: string; cost: string }>;
		};
		fee_structure: {
			commission_rate: string;
			monthly_fee: string;
			fulfillment_options: string[];
			advertising_minimum: string;
		};
		competitive_landscape: {
			competitor_count: string;
			price_range: string;
			dominant_players: string[];
			differentiation_opportunity: string;
		};
		operations_requirements: {
			inventory_model: string;
			cs_requirements: string;
			content_requirements: string[];
			update_frequency: string;
		};
		kpis: Array<{ metric: string; target: string; timeline: string }>;
	}>;
	launch_sequence: Array<{
		phase: string;
		channels: string[];
		timeline: string;
		rationale: string;
	}>;
}

export interface PricingMarginOutput {
	product_pricing: Array<{
		product_code: string;
		product_name: string;
		cost_basis: {
			cost_price: number;
			wholesale_rate: number;
			current_tv_price: number;
		};
		channel_pricing: Array<{
			channel: string;
			recommended_price: number;
			competitor_benchmark: string;
			channel_fees: string;
			net_margin_pct: number;
			net_margin_yen: number;
			reasoning: string;
		}>;
	}>;
	bep_analysis: Array<{
		channel: string;
		fixed_costs: Array<{ item: string; monthly: number }>;
		variable_cost_per_unit: number;
		bep_units: number;
		bep_revenue: number;
		bep_timeline: string;
	}>;
	margin_optimization: string[];
}

export interface MarketingExecutionOutput {
	monthly_plans: Array<{
		month: string;
		total_budget: number;
		activities: Array<{
			channel: string;
			activity: string;
			budget: number;
			expected_impressions: string;
			expected_conversions: string;
			content_type: string;
		}>;
	}>;
	content_calendar: Array<{
		week: string;
		channel: string;
		content_type: string;
		topic: string;
		product_focus: string;
	}>;
	influencer_plan: Array<{
		tier: "mega" | "macro" | "micro";
		count: number;
		budget_per_person: string;
		selection_criteria: string;
		expected_roi: string;
		platform: string;
	}>;
	budget_summary: {
		total_6month: number;
		by_channel: Record<string, number>;
		by_type: Record<string, number>;
	};
}

export interface FinancialProjectionOutput {
	monthly_forecast: Array<{
		month: string;
		by_channel: Array<{
			channel: string;
			revenue: number;
			cost: number;
			marketing_spend: number;
			net_profit: number;
			cumulative_profit: number;
		}>;
		total_revenue: number;
		total_profit: number;
	}>;
	roi_timeline: Array<{
		channel: string;
		total_investment: number;
		breakeven_month: string;
		year1_roi_pct: number;
		year1_net_profit: number;
	}>;
	scenarios: {
		conservative: { year1_revenue: number; year1_profit: number };
		moderate: { year1_revenue: number; year1_profit: number };
		aggressive: { year1_revenue: number; year1_profit: number };
		assumptions: string[];
	};
}

export interface RiskContingencyOutput {
	risk_matrix: Array<{
		channel: string;
		risks: Array<{
			risk: string;
			category: "operational" | "financial" | "competitive" | "regulatory" | "market";
			likelihood: "high" | "medium" | "low";
			impact: "high" | "medium" | "low";
			mitigation: string[];
			contingency_trigger: string;
			contingency_action: string;
		}>;
	}>;
	top_5_risks: Array<{
		risk: string;
		channel: string;
		mitigation_playbook: string[];
		owner: string;
		review_frequency: string;
	}>;
	go_nogo_criteria: Array<{
		channel: string;
		criteria: string[];
		decision_date: string;
	}>;
}

export interface FullStrategyResult {
	product_selection: ProductSelectionOutput;
	channel_strategy: ChannelStrategyOutput;
	pricing_margin: PricingMarginOutput;
	marketing_execution: MarketingExecutionOutput;
	financial_projection: FinancialProjectionOutput;
	risk_contingency: RiskContingencyOutput;
}

// ---------------------------------------------------------------------------
// Skill Names & Progress Events
// ---------------------------------------------------------------------------

export type SkillName =
	| "product_selection"
	| "channel_strategy"
	| "pricing_margin"
	| "marketing_execution"
	| "financial_projection"
	| "risk_contingency";

export const SKILL_META: Record<SkillName, { label: string; labelJa: string }> = {
	product_selection: { label: "Product Selection", labelJa: "商品選定" },
	channel_strategy: { label: "Channel Strategy", labelJa: "チャネル戦略" },
	pricing_margin: { label: "Pricing & Margin", labelJa: "価格・マージン戦略" },
	marketing_execution: { label: "Marketing Execution", labelJa: "マーケティング実行計画" },
	financial_projection: { label: "Financial Projection", labelJa: "収益予測" },
	risk_contingency: { label: "Risk & Contingency", labelJa: "リスク・対策" },
};

export interface ProgressEvent {
	skill: SkillName;
	status: "running" | "complete" | "error";
	index: number;
	total: number;
	data?: unknown;
	error?: string;
}

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

function buildContextHeader(ctx: StrategyContext): string {
	const catLines = ctx.categoryBreakdown
		.slice(0, 12)
		.map((c) => `  - ${c.category}: 売上¥${c.revenue.toLocaleString()} / 粗利率${c.marginRate}% / ${c.quantity.toLocaleString()}個 / ${c.productCount}商品`)
		.join("\n");

	return `=== TV通販（テレビ東京ダイレクト）全体実績 ===
- 総売上: ¥${ctx.annualMetrics.totalRevenue.toLocaleString()}
- 総粗利: ¥${ctx.annualMetrics.totalProfit.toLocaleString()}
- 粗利率: ${ctx.annualMetrics.marginRate}%
- 集計期間: ${ctx.annualMetrics.weekCount}週間 (2025-2026年)
- 取扱商品数: ${ctx.annualMetrics.productCount}

=== カテゴリ別実績 ===
${catLines}`;
}

function buildProductLines(products: EnrichedProduct[], limit: number = 30): string {
	return products
		.slice(0, limit)
		.map((p, i) => {
			const parts = [
				`${i + 1}. ${p.name} [${p.category ?? "分類なし"}]`,
				`  売上: ¥${p.totalRevenue.toLocaleString()} / 粗利率: ${p.marginRate}% / 週平均${p.avgWeeklyQty}個 / ${p.weekCount}週`,
			];
			if (p.costPrice != null) parts.push(`  原価: ¥${p.costPrice.toLocaleString()} / 卸売率: ${p.wholesaleRate ?? "不明"}%`);
			if (p.manufacturer) parts.push(`  メーカー: ${p.manufacturer}${p.manufacturerCountry ? ` (${p.manufacturerCountry})` : ""}`);
			if (p.monthlyTrend.length >= 3) {
				const recent3 = p.monthlyTrend.slice(-3);
				const trendStr = recent3.map((m) => `${m.month}: ¥${m.revenue.toLocaleString()}`).join(" → ");
				parts.push(`  直近3ヶ月推移: ${trendStr}`);
			}
			if (p.research) {
				parts.push(`  AI市場性スコア: ${p.research.marketabilityScore}/100`);
				if (p.research.competitors.length > 0) {
					const compStr = p.research.competitors.slice(0, 2).map((c) => `${c.name}(${c.platform}, ${c.price})`).join(", ");
					parts.push(`  競合: ${compStr}`);
				}
			}
			return parts.join("\n");
		})
		.join("\n\n");
}

function buildProductSelectionPrompt(ctx: StrategyContext): string {
	const userGoalSection = ctx.userGoal
		? `\n=== ユーザーの目標 ===\n${ctx.userGoal}\n上記の目標を最優先に踏まえて商品選定を行ってください。\n`
		: "";

	return `あなたはTV通販チャネルのMD（マーチャンダイザー）です。EC・SNS・D2C・越境ECへの商品展開を計画しています。

以下のTV通販実績データに基づき、各チャネルに投入すべき商品を選定してください。
${userGoalSection}
${buildContextHeader(ctx)}

=== 商品実績データ（上位30商品、原価・メーカー・月次推移・AI分析含む） ===
${buildProductLines(ctx.products)}

=== 対象チャネル ===
1. Amazon Japan
2. 楽天市場
3. Yahoo!ショッピング
4. TikTok Shop Japan
5. Instagram Shopping
6. 越境EC（Coupang韓国 / Shopee東南アジア）
7. 自社EC（D2C）

=== 選定ルール ===
- tier1_products: 各チャネルに最初に投入すべき商品（3-5品）。必ず売上・粗利率・月次推移データを引用して根拠を示すこと。
- tier2_products: 第2弾として投入する商品（2-3品）。
- exclusions: そのチャネルに不適合な商品とその理由。
- monthly_trajectory: 直近3ヶ月の売上推移から growing/stable/declining を判定。
- margin_headroom: 原価データがある商品は「原価¥X、EC手数料Y%でも粗利Z%確保可能」のように計算。
- portfolio_strategy: 全体のポートフォリオ戦略（カテゴリバランス、季節性、価格帯分散）を記述。

IMPORTANT: すべてのテキストフィールドは日本語で記述してください。

Return a JSON object (no markdown) with this structure:
{
  "channel_product_matrix": [
    {
      "channel": "チャネル名",
      "tier1_products": [{"code": "商品コード", "name": "商品名", "reason": "データ引用した根拠", "monthly_trajectory": "growing|stable|declining", "margin_headroom": "マージン計算"}],
      "tier2_products": [{"code": "商品コード", "name": "商品名", "reason": "根拠"}],
      "exclusions": [{"code": "商品コード", "name": "商品名", "reason": "不適合理由"}]
    }
  ],
  "portfolio_strategy": "全体戦略"
}`;
}

function buildChannelStrategyPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const ps = priorOutputs.product_selection as ProductSelectionOutput;
	const productSelectionSummary = ps.channel_product_matrix
		.map((ch) => `${ch.channel}: tier1=${ch.tier1_products.map((p) => p.name).join(", ")}`)
		.join("\n");

	return `あなたはEC・SNSコマース専門の戦略コンサルタントです。TV通販MDが各チャネルへ展開する際の詳細な進出戦略を策定してください。

${buildContextHeader(ctx)}

=== 商品選定結果（前ステップ） ===
${productSelectionSummary}
ポートフォリオ戦略: ${ps.portfolio_strategy}

=== 各チャネルについて以下を詳細に分析 ===
1. Amazon Japan / 2. 楽天市場 / 3. Yahoo!ショッピング / 4. TikTok Shop / 5. Instagram Shopping / 6. 越境EC / 7. 自社EC

各チャネルについて:
- priority: immediate（即時開始）/ 3month / 6month / 12month
- entry_requirements: アカウント種別、必要書類、セットアップ期間、初期費用（具体的な金額）
- fee_structure: 販売手数料率、月額費用、フルフィルメント選択肢、最低広告出稿額
- competitive_landscape: 類似商品の競合数、価格帯、主要プレーヤー、差別化機会
- operations_requirements: 在庫モデル（FBA/自社出荷等）、CS体制、コンテンツ要件、更新頻度
- kpis: 各チャネルの目標KPI（具体的な数値目標と達成期限）
- launch_sequence: フェーズ分けした展開順序と根拠

IMPORTANT: すべてのテキストフィールドは日本語で記述してください。数字は具体的な金額・数値で記載すること。

Return a JSON object (no markdown) with this structure:
{
  "channels": [
    {
      "name": "", "priority": "immediate|3month|6month|12month", "fit_score": 0, "market_size": "",
      "entry_requirements": {"account_type": "", "required_documents": [], "setup_timeline": "", "initial_costs": [{"item": "", "cost": ""}]},
      "fee_structure": {"commission_rate": "", "monthly_fee": "", "fulfillment_options": [], "advertising_minimum": ""},
      "competitive_landscape": {"competitor_count": "", "price_range": "", "dominant_players": [], "differentiation_opportunity": ""},
      "operations_requirements": {"inventory_model": "", "cs_requirements": "", "content_requirements": [], "update_frequency": ""},
      "kpis": [{"metric": "", "target": "", "timeline": ""}]
    }
  ],
  "launch_sequence": [{"phase": "", "channels": [], "timeline": "", "rationale": ""}]
}`;
}

function buildPricingMarginPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const ps = priorOutputs.product_selection as ProductSelectionOutput;
	const cs = priorOutputs.channel_strategy as ChannelStrategyOutput;

	// Collect tier1 product codes across all channels
	const tier1Codes = new Set<string>();
	for (const ch of ps.channel_product_matrix) {
		for (const p of ch.tier1_products) tier1Codes.add(p.code);
	}

	const tier1Products = ctx.products.filter((p) => tier1Codes.has(p.code));
	const productPricingData = tier1Products
		.map((p) => {
			const tvPrice = p.totalQuantity > 0 ? Math.round(p.totalRevenue / p.totalQuantity) : 0;
			const lines = [`${p.name} [${p.code}]: TV単価¥${tvPrice.toLocaleString()}`];
			if (p.costPrice != null) lines.push(`  原価: ¥${p.costPrice.toLocaleString()}`);
			if (p.wholesaleRate != null) lines.push(`  卸売率: ${p.wholesaleRate}%`);
			if (p.research?.competitors.length) {
				lines.push(`  競合価格: ${p.research.competitors.map((c) => `${c.name}=${c.price}`).join(", ")}`);
			}
			if (p.skus?.length) {
				const priceRange = p.skus.filter((s) => s.price_incl).map((s) => s.price_incl!);
				if (priceRange.length) lines.push(`  SKU価格帯: ¥${Math.min(...priceRange).toLocaleString()}〜¥${Math.max(...priceRange).toLocaleString()}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");

	const channelFees = cs.channels
		.map((ch) => `${ch.name}: 手数料${ch.fee_structure.commission_rate}, 月額${ch.fee_structure.monthly_fee}`)
		.join("\n");

	return `あなたはEC事業の価格戦略スペシャリストです。TV通販商品のEC展開における最適価格を設計してください。

=== 対象商品の原価・価格データ ===
${productPricingData}

=== チャネル手数料構造 ===
${channelFees}

=== 分析要件 ===
各商品×各チャネルの組み合わせについて:
- recommended_price: EC販売推奨価格（競合価格・原価・手数料を考慮）
- competitor_benchmark: 競合の平均価格帯
- channel_fees: そのチャネルの手数料（販売手数料+フルフィルメント費等）
- net_margin_pct / net_margin_yen: 手数料控除後の純粋な粗利（率と金額）
- reasoning: なぜこの価格が最適か

BEP分析:
- 各チャネルの固定費（月額費用、広告費、人件費等）を列挙
- 変動費（原価+手数料）から損益分岐販売数を算出
- 損益分岐達成の見込み期間

IMPORTANT: すべてのテキストフィールドは日本語で記述。計算は実際の原価データに基づくこと。

Return a JSON object (no markdown) with this structure:
{
  "product_pricing": [
    {
      "product_code": "", "product_name": "",
      "cost_basis": {"cost_price": 0, "wholesale_rate": 0, "current_tv_price": 0},
      "channel_pricing": [{"channel": "", "recommended_price": 0, "competitor_benchmark": "", "channel_fees": "", "net_margin_pct": 0, "net_margin_yen": 0, "reasoning": ""}]
    }
  ],
  "bep_analysis": [
    {"channel": "", "fixed_costs": [{"item": "", "monthly": 0}], "variable_cost_per_unit": 0, "bep_units": 0, "bep_revenue": 0, "bep_timeline": ""}
  ],
  "margin_optimization": ["具体的な改善提案"]
}`;
}

function buildMarketingExecutionPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const ps = priorOutputs.product_selection as ProductSelectionOutput;
	const cs = priorOutputs.channel_strategy as ChannelStrategyOutput;
	const pm = priorOutputs.pricing_margin as PricingMarginOutput;

	const channelPriorities = cs.channels
		.map((ch) => `${ch.name} (${ch.priority}): 適合度${ch.fit_score}, 広告最低額${ch.fee_structure.advertising_minimum}`)
		.join("\n");

	const tier1Summary = ps.channel_product_matrix
		.map((ch) => `${ch.channel}: ${ch.tier1_products.map((p) => p.name).join(", ")}`)
		.join("\n");

	// Gather research-based marketing insights
	const marketingInsights = ctx.products
		.filter((p) => p.research?.marketingStrategy?.length)
		.slice(0, 5)
		.map((p) => `${p.name}: ${p.research!.marketingStrategy.map((s) => `${s.strategy_name}(効率${s.efficiency_score})`).join(", ")}`)
		.join("\n");

	const bepSummary = pm.bep_analysis
		.map((b) => `${b.channel}: 損益分岐${b.bep_units}個/月, 達成見込${b.bep_timeline}`)
		.join("\n");

	return `あなたはEC・SNSマーケティングの実行プランナーです。TV通販からのEC展開における6ヶ月間の具体的なマーケティング実行計画を策定してください。

=== チャネル優先度・広告要件 ===
${channelPriorities}

=== 商品ラインナップ ===
${tier1Summary}

=== AI分析によるマーケティング示唆 ===
${marketingInsights || "（個別商品のAI分析データなし）"}

=== 損益分岐目標 ===
${bepSummary}

=== 策定要件 ===
- monthly_plans: 6ヶ月分の月別計画。各月のアクティビティに具体的な予算（¥）、想定インプレッション数、想定コンバージョン数を記載。
- content_calendar: 最初の2ヶ月（8週）の週別コンテンツ計画。チャネル・コンテンツ種類・テーマ・フォーカス商品を記載。
- influencer_plan: ティア別（mega/macro/micro）のインフルエンサー施策。人数・1人あたり予算・選定基準・想定ROI。
- budget_summary: 6ヶ月間の総予算と、チャネル別・施策種別（広告/コンテンツ/インフルエンサー/PR）の内訳。

IMPORTANT: すべて日本語で記述。金額は¥で表記。具体的な数値目標を含めること。

Return a JSON object (no markdown) with this structure:
{
  "monthly_plans": [{"month": "2026年4月", "total_budget": 0, "activities": [{"channel": "", "activity": "", "budget": 0, "expected_impressions": "", "expected_conversions": "", "content_type": ""}]}],
  "content_calendar": [{"week": "Week1", "channel": "", "content_type": "", "topic": "", "product_focus": ""}],
  "influencer_plan": [{"tier": "micro", "count": 0, "budget_per_person": "", "selection_criteria": "", "expected_roi": "", "platform": ""}],
  "budget_summary": {"total_6month": 0, "by_channel": {}, "by_type": {}}
}`;
}

function buildFinancialProjectionPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const cs = priorOutputs.channel_strategy as ChannelStrategyOutput;
	const pm = priorOutputs.pricing_margin as PricingMarginOutput;
	const me = priorOutputs.marketing_execution as MarketingExecutionOutput;

	const channelCosts = cs.channels.map((ch) => {
		const bep = pm.bep_analysis.find((b) => b.channel === ch.name);
		return `${ch.name}: 初期投資=${ch.entry_requirements.initial_costs.map((c) => `${c.item}:${c.cost}`).join("+")}` +
			(bep ? `, BEP=${bep.bep_units}個/月` : "");
	}).join("\n");

	const pricingSummary = pm.product_pricing.slice(0, 5).map((pp) => {
		const chPrices = pp.channel_pricing.map((cp) => `${cp.channel}:¥${cp.recommended_price}(粗利${cp.net_margin_pct}%)`).join(", ");
		return `${pp.product_name}: ${chPrices}`;
	}).join("\n");

	const marketingBudget = `6ヶ月総額: ¥${me.budget_summary.total_6month.toLocaleString()}\n` +
		Object.entries(me.budget_summary.by_channel).map(([ch, amt]) => `  ${ch}: ¥${amt.toLocaleString()}`).join("\n");

	// TV sales as baseline reference
	const tvBaseline = `TV通販実績: 月平均売上¥${Math.round(ctx.annualMetrics.totalRevenue / Math.max(ctx.annualMetrics.weekCount / 4, 1)).toLocaleString()}`;

	return `あなたは事業計画の財務モデリング専門家です。TV通販からのEC展開における12ヶ月間の収益予測を作成してください。

=== 基礎データ ===
${tvBaseline}

=== チャネル別コスト構造 ===
${channelCosts}

=== 商品別チャネル価格・粗利 ===
${pricingSummary}

=== マーケティング予算 ===
${marketingBudget}

=== 予測要件 ===
- monthly_forecast: 12ヶ月分（2026年4月〜2027年3月）のチャネル別月次予測。売上・原価・マーケティング費・純利益・累積利益を記載。
  - 初月は控えめ、段階的に成長するリアルな予測とすること。
  - チャネルの立ち上げ順序（launch_sequence）を反映すること。
- roi_timeline: チャネル別の総投資額・損益分岐月・1年目ROI%・1年目純利益。
- scenarios: 保守的/中立/積極的の3シナリオ。各シナリオの前提条件を明記。

IMPORTANT: すべて日本語で記述。金額はすべて日本円。

Return a JSON object (no markdown) with this structure:
{
  "monthly_forecast": [{"month": "2026年4月", "by_channel": [{"channel": "", "revenue": 0, "cost": 0, "marketing_spend": 0, "net_profit": 0, "cumulative_profit": 0}], "total_revenue": 0, "total_profit": 0}],
  "roi_timeline": [{"channel": "", "total_investment": 0, "breakeven_month": "", "year1_roi_pct": 0, "year1_net_profit": 0}],
  "scenarios": {"conservative": {"year1_revenue": 0, "year1_profit": 0}, "moderate": {"year1_revenue": 0, "year1_profit": 0}, "aggressive": {"year1_revenue": 0, "year1_profit": 0}, "assumptions": []}
}`;
}

function buildRiskContingencyPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const cs = priorOutputs.channel_strategy as ChannelStrategyOutput;
	const fp = priorOutputs.financial_projection as FinancialProjectionOutput;

	const channelOverview = cs.channels.map((ch) => {
		const roi = fp.roi_timeline.find((r) => r.channel === ch.name);
		return `${ch.name} (${ch.priority}): 適合度${ch.fit_score}, ` +
			`初期投資${ch.entry_requirements.initial_costs.map((c) => c.cost).join("+")}` +
			(roi ? `, 1年目ROI ${roi.year1_roi_pct}%` : "");
	}).join("\n");

	const scenarios = fp.scenarios;

	return `あなたはEC事業のリスクマネジメント専門家です。TV通販からのEC展開における包括的なリスク分析と対策計画を策定してください。

=== チャネル展開概要 ===
${channelOverview}

=== 収益シナリオ ===
- 保守的: 年間売上¥${scenarios.conservative.year1_revenue.toLocaleString()}, 利益¥${scenarios.conservative.year1_profit.toLocaleString()}
- 中立的: 年間売上¥${scenarios.moderate.year1_revenue.toLocaleString()}, 利益¥${scenarios.moderate.year1_profit.toLocaleString()}
- 積極的: 年間売上¥${scenarios.aggressive.year1_revenue.toLocaleString()}, 利益¥${scenarios.aggressive.year1_profit.toLocaleString()}
前提: ${scenarios.assumptions.join(", ")}

=== 分析要件 ===
- risk_matrix: 各チャネルのリスクを category（operational/financial/competitive/regulatory/market）別に列挙。
  - likelihood（可能性）とimpact（影響度）をhigh/medium/lowで評価。
  - mitigation: 予防策（複数）
  - contingency_trigger: 発動条件（具体的な数値基準）
  - contingency_action: 発動時の具体的アクション
- top_5_risks: 全チャネル通じて最も重要なリスクTOP5と詳細な対応プレイブック。
- go_nogo_criteria: 各チャネルの継続/撤退判断基準と判断期日。

IMPORTANT: すべて日本語で記述。抽象的な表現は避け、「月間売上¥X未満が3ヶ月続いた場合」のように具体的な基準で記述すること。

Return a JSON object (no markdown) with this structure:
{
  "risk_matrix": [{"channel": "", "risks": [{"risk": "", "category": "operational", "likelihood": "high", "impact": "high", "mitigation": [], "contingency_trigger": "", "contingency_action": ""}]}],
  "top_5_risks": [{"risk": "", "channel": "", "mitigation_playbook": [], "owner": "", "review_frequency": ""}],
  "go_nogo_criteria": [{"channel": "", "criteria": [], "decision_date": ""}]
}`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

type PromptBuilder = (ctx: StrategyContext, priorOutputs: Record<string, unknown>) => string;

const SKILL_PIPELINE: Array<{ name: SkillName; buildPrompt: PromptBuilder }> = [
	{ name: "product_selection", buildPrompt: (ctx) => buildProductSelectionPrompt(ctx) },
	{ name: "channel_strategy", buildPrompt: buildChannelStrategyPrompt },
	{ name: "pricing_margin", buildPrompt: buildPricingMarginPrompt },
	{ name: "marketing_execution", buildPrompt: buildMarketingExecutionPrompt },
	{ name: "financial_projection", buildPrompt: buildFinancialProjectionPrompt },
	{ name: "risk_contingency", buildPrompt: buildRiskContingencyPrompt },
];

export async function runStrategyOrchestrator(
	context: StrategyContext,
	onProgress: (event: ProgressEvent) => void,
): Promise<FullStrategyResult> {
	const outputs: Record<string, unknown> = {};

	for (let i = 0; i < SKILL_PIPELINE.length; i++) {
		const skill = SKILL_PIPELINE[i];
		onProgress({ skill: skill.name, status: "running", index: i, total: SKILL_PIPELINE.length });

		try {
			const prompt = skill.buildPrompt(context, outputs);
			const raw = await callGemini(prompt);
			const parsed = parseJSON(raw);
			outputs[skill.name] = parsed;
			onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: parsed });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			onProgress({ skill: skill.name, status: "error", index: i, total: SKILL_PIPELINE.length, error: message });
			// Set empty fallback so subsequent skills don't crash
			outputs[skill.name] = {};
		}
	}

	return outputs as unknown as FullStrategyResult;
}
