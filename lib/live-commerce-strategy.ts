import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServiceClient } from "@/lib/supabase";
import { discoverNewProducts, type DiscoveredProduct, type DiscoveryBatch } from "@/lib/md-strategy";

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

async function callGemini(prompt: string): Promise<string> {
	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
	const streamPromise = (async () => {
		const result = await model.generateContentStream(prompt);
		let text = "";
		for await (const chunk of result.stream) {
			text += chunk.text();
		}
		return text.trim();
	})();
	const timeoutPromise = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("Gemini timeout (90s)")), 90000),
	);
	return await Promise.race([streamPromise, timeoutPromise]);
}

function parseJSON<T>(raw: string): T {
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) throw new Error("Failed to parse JSON from Gemini response");
	return JSON.parse(match[0]) as T;
}

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

export interface SearchSource {
	title: string;
	url: string;
	description: string;
	query: string;
}

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

async function braveSearch(query: string): Promise<SearchSource[]> {
	if (!BRAVE_API_KEY) return [];
	try {
		const res = await fetch(
			`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
			{
				headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_API_KEY },
				signal: AbortSignal.timeout(4000),
			},
		);
		if (!res.ok) return [];
		const data = await res.json();
		return (data.web?.results ?? []).slice(0, 5).map((r: { title?: string; url?: string; description?: string }) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			description: r.description ?? "",
			query,
		}));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Platform Reference Table
// ---------------------------------------------------------------------------

export const PLATFORM_REFERENCE = [
	{ name: "TikTok Live", commission: "2-8%", minFollowers: "1,000+", demographics: "10-30代", avgViewers: "100-10,000", entryDifficulty: "中" },
	{ name: "Instagram Live", commission: "5%", minFollowers: "制限なし", demographics: "20-40代女性", avgViewers: "50-5,000", entryDifficulty: "低" },
	{ name: "YouTube Live", commission: "0% (Super Chat 30%)", minFollowers: "50+", demographics: "全年齢", avgViewers: "50-50,000", entryDifficulty: "中" },
	{ name: "楽天ROOM LIVE", commission: "楽天手数料に含む", minFollowers: "制限なし", demographics: "30-50代", avgViewers: "50-2,000", entryDifficulty: "低" },
	{ name: "Yahoo!ショッピング LIVE", commission: "Yahoo!手数料に含む", minFollowers: "出店者のみ", demographics: "30-50代", avgViewers: "50-1,000", entryDifficulty: "中" },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LCSkillName =
	| "goal_analysis"
	| "market_research"
	| "platform_analysis"
	| "content_strategy"
	| "execution_plan"
	| "risk_analysis";

export const LC_SKILL_META: Record<LCSkillName, { label: string; labelJa: string }> = {
	goal_analysis: { label: "Goal Analysis", labelJa: "目標分析" },
	market_research: { label: "Market Research", labelJa: "市場調査" },
	platform_analysis: { label: "Platform Analysis", labelJa: "プラットフォーム分析" },
	content_strategy: { label: "Content Strategy", labelJa: "コンテンツ戦略" },
	execution_plan: { label: "Execution Plan", labelJa: "実行ロードマップ" },
	risk_analysis: { label: "Risk Analysis", labelJa: "リスク分析" },
};

export interface LCProgressEvent {
	skill: LCSkillName | "data_fetch";
	status: "running" | "complete" | "error";
	index: number;
	total: number;
	data?: unknown;
	error?: string;
}

export interface ParsedGoal {
	primary_objective: string;
	target_platforms: string[];
	budget_range?: string;
	timeline?: string;
	target_audience?: string;
}

export interface MarketResearchOutput {
	market_size: string;
	growth_rate: string;
	key_trends: Array<{ trend: string; description: string }>;
	major_players: Array<{ name: string; platform: string; description: string }>;
	consumer_behavior: string;
	market_outlook: string;
	sources_referenced: number[];
}

export interface PlatformAnalysisOutput {
	// Newly discovered products from real Rakuten/Web search (injected by orchestrator)
	discovered_new_products?: DiscoveredProduct[];
	discovery_history?: DiscoveryBatch[];
	platforms: Array<{
		name: string;
		fit_score: number;
		user_base: string;
		commission_structure: string;
		strengths: string[];
		weaknesses: string[];
		success_cases: Array<{ brand: string; description: string; result: string }>;
		recommended_products: string[];
		entry_steps: string[];
		our_recommended_products: Array<{ code: string; name: string; reason: string }>;
		search_keywords: string[];
	}>;
	comparison_summary: string;
	recommended_priority: string[];
}

export interface ContentStrategyOutput {
	platforms: Array<{
		name: string;
		broadcast_format: string;
		optimal_times: string[];
		frequency: string;
		host_style: string;
		content_ideas: Array<{ title: string; description: string; format: string }>;
		engagement_tactics: string[];
		sample_script_outline: string;
	}>;
	cross_platform_strategy: string;
}

export interface ExecutionPlanOutput {
	phases: Array<{
		phase: string;
		period: string;
		objectives: string[];
		actions: Array<{ action: string; owner: string; deadline: string }>;
		budget: string;
		kpis: Array<{ metric: string; target: string }>;
	}>;
	total_investment: string;
	staffing: Array<{ role: string; type: string; timing: string }>;
	tools_and_services: Array<{ name: string; purpose: string; cost: string }>;
}

export interface RiskAnalysisOutput {
	risks: Array<{
		category: string;
		description: string;
		severity: "high" | "medium" | "low";
		probability: "high" | "medium" | "low";
		mitigation: string;
	}>;
	contingency_plans: Array<{ scenario: string; response: string }>;
	success_factors: string[];
}

export interface FullLCStrategyResult {
	goal_analysis: ParsedGoal | null;
	market_research: MarketResearchOutput;
	platform_analysis: PlatformAnalysisOutput;
	content_strategy: ContentStrategyOutput;
	execution_plan: ExecutionPlanOutput;
	risk_analysis: RiskAnalysisOutput;
}

// ---------------------------------------------------------------------------
// Search Queries
// ---------------------------------------------------------------------------

const STATIC_QUERIES = [
	"日本 ライブコマース 市場規模 2025 2026",
	"ライブコマース プラットフォーム 比較 日本",
	"TikTok Live 日本 売上 成功事例",
	"Instagram ライブ販売 日本 戦略",
	"YouTube Live ショッピング 日本",
	"楽天ROOM LIVE 出店 手数料",
];

function buildDynamicQueries(goal: ParsedGoal): string[] {
	const queries: string[] = [];
	for (const platform of goal.target_platforms.slice(0, 2)) {
		queries.push(`${platform} ライブコマース 日本 攻略`);
	}
	return queries;
}

export interface LCProduct {
	code: string;
	name: string;
	category: string | null;
	totalRevenue: number;
	totalQuantity: number;
	marginRate: number;
}

export interface LCContext {
	userGoal?: string;
	targetPlatforms?: string[];
	parsedGoal?: ParsedGoal;
	searchSources: SearchSource[];
	searchSummary: string;
	products: LCProduct[];
	recommendedProducts?: DiscoveredProduct[];
	recommendedProductsPromise?: Promise<DiscoveredProduct[] | undefined>;
}

export async function fetchLCContext(
	userGoal?: string,
	targetPlatforms?: string[],
): Promise<LCContext> {
	// Run search queries and DB fetch in parallel
	const [searchResults, productResult] = await Promise.all([
		Promise.all(STATIC_QUERIES.map((q) => braveSearch(q))),
		fetchTopProducts(),
	]);

	const allSources = searchResults.flat();
	const searchSummary = allSources
		.map((s, i) => `[${i + 1}] ${s.title}\n${s.description}\n(${s.url})`)
		.join("\n\n");

	// Derive top categories from category_summaries (same source as MD) for reliability.
	// Falls back to product-derived categories if the table is empty.
	let topCategoryNames: string[] = [];
	try {
		const supabase = getServiceClient();
		const { data: catRows } = await supabase
			.from("category_summaries")
			.select("category, total_revenue")
			.in("year", [2025, 2026]);
		if (catRows && catRows.length > 0) {
			const catMap: Record<string, number> = {};
			for (const row of catRows as Array<{ category: string; total_revenue: number | null }>) {
				catMap[row.category] = (catMap[row.category] ?? 0) + (row.total_revenue ?? 0);
			}
			topCategoryNames = Object.entries(catMap)
				.sort(([, a], [, b]) => b - a)
				.slice(0, 3)
				.map(([cat]) => cat);
		}
	} catch (err) {
		console.warn("[live-commerce] category_summaries query failed:", err);
	}
	if (topCategoryNames.length === 0) {
		// Fallback: derive from product_summaries
		const categoryRevenue: Record<string, number> = {};
		for (const p of productResult) {
			const cat = p.category ?? "その他";
			categoryRevenue[cat] = (categoryRevenue[cat] ?? 0) + p.totalRevenue;
		}
		topCategoryNames = Object.entries(categoryRevenue)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 3)
			.map(([cat]) => cat);
	}
	// Final fallback: hardcoded common JP live-commerce categories so discovery never returns empty
	if (topCategoryNames.length === 0) {
		topCategoryNames = ["美容", "健康食品", "キッチン家電"];
	}
	console.log(`[live-commerce] topCategoryNames=${JSON.stringify(topCategoryNames)}`);

	const avgMarginRate = productResult.length > 0
		? Math.round(productResult.reduce((s, p) => s + p.marginRate, 0) / productResult.length)
		: 0;

	const recommendedProductsPromise = discoverNewProducts({
		context: "live_commerce",
		topCategoryNames,
		userGoal,
		tvProductNames: productResult.map((p) => p.name),
		tvMarginRate: avgMarginRate,
	}).catch((err) => {
		console.error("[live-commerce] discovery failed:", err);
		return undefined;
	});

	return {
		userGoal,
		targetPlatforms,
		searchSources: allSources,
		searchSummary,
		products: productResult,
		recommendedProductsPromise,
	};
}

async function fetchTopProducts(): Promise<LCProduct[]> {
	try {
		const supabase = getServiceClient();
		const { data } = await supabase
			.from("product_summaries")
			.select("product_code, product_name, category, total_revenue, total_quantity, margin_rate")
			.order("total_revenue", { ascending: false })
			.limit(30);

		if (!data) return [];

		// Merge across years by product_code
		const map = new Map<string, LCProduct>();
		for (const row of data) {
			const existing = map.get(row.product_code);
			if (existing) {
				existing.totalRevenue += row.total_revenue ?? 0;
				existing.totalQuantity += row.total_quantity ?? 0;
			} else {
				map.set(row.product_code, {
					code: row.product_code,
					name: row.product_name,
					category: row.category,
					totalRevenue: row.total_revenue ?? 0,
					totalQuantity: row.total_quantity ?? 0,
					marginRate: row.margin_rate ?? 0,
				});
			}
		}

		return [...map.values()]
			.sort((a, b) => b.totalRevenue - a.totalRevenue)
			.slice(0, 20);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Skill 0: Goal Analysis
// ---------------------------------------------------------------------------

async function runGoalAnalysis(userGoal: string): Promise<ParsedGoal> {
	const prompt = `あなたはライブコマース戦略コンサルタントです。以下のユーザー目標を構造化してください。

ユーザー入力: "${userGoal}"

以下のJSON形式で出力:
{
  "primary_objective": "<主な目的を1-2文で>",
  "target_platforms": ["<プラットフォーム名>"],
  "budget_range": "<予算範囲（言及がなければnull）>",
  "timeline": "<タイムライン（言及がなければnull）>",
  "target_audience": "<ターゲット層（言及がなければnull）>"
}

注意:
- target_platformsが明示されていない場合はTikTok Live, Instagram Live, YouTube Liveをデフォルトで含める
- 全てのテキストは日本語で出力`;

	const raw = await callGemini(prompt);
	return parseJSON<ParsedGoal>(raw);
}

// ---------------------------------------------------------------------------
// Skill pipeline definition
// ---------------------------------------------------------------------------

interface SkillDef {
	name: LCSkillName;
	buildPrompt: (ctx: LCContext, outputs: Record<string, unknown>) => string;
}

function formatPlatformRef(): string {
	return PLATFORM_REFERENCE.map((p) =>
		`- ${p.name}: 手数料${p.commission}, フォロワー条件${p.minFollowers}, 主な層${p.demographics}, 視聴者数${p.avgViewers}, 参入難易度${p.entryDifficulty}`
	).join("\n");
}

function goalSection(ctx: LCContext): string {
	if (!ctx.parsedGoal) return "";
	const g = ctx.parsedGoal;
	return `
=== ユーザー目標 ===
- 主な目的: ${g.primary_objective}
- 対象プラットフォーム: ${g.target_platforms.join(", ")}
${g.budget_range ? `- 予算: ${g.budget_range}` : ""}
${g.timeline ? `- タイムライン: ${g.timeline}` : ""}
${g.target_audience ? `- ターゲット層: ${g.target_audience}` : ""}
上記の目標を全ての分析で最優先に考慮してください。
`;
}

const SKILL_PIPELINE: SkillDef[] = [
	{
		name: "goal_analysis",
		buildPrompt: () => "",
	},
	{
		name: "market_research",
		buildPrompt: (ctx) => `あなたは日本のライブコマース市場の専門アナリストです。
以下のウェブ検索結果に基づき、日本のライブコマース市場を分析してください。

=== ウェブ検索結果 ===
${ctx.searchSummary}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "market_size": "<日本のライブコマース市場規模>",
  "growth_rate": "<年間成長率>",
  "key_trends": [{"trend": "<トレンド名>", "description": "<説明>"}],
  "major_players": [{"name": "<企業/人物名>", "platform": "<プラットフォーム>", "description": "<概要>"}],
  "consumer_behavior": "<日本の消費者のライブコマースに対する行動特性>",
  "market_outlook": "<今後の市場見通し>",
  "sources_referenced": [<使用したソースの番号>]
}

注意:
- key_trendsは5-8個
- major_playersは5-10個
- 全てのテキストは日本語で出力
- ウェブ検索結果を根拠として活用し、sources_referencedで番号を記載`,
	},
	{
		name: "platform_analysis",
		buildPrompt: (ctx, outputs) => {
			const productList = ctx.products.length > 0
				? `\n=== 自社商品データ（売上上位） ===\n${ctx.products.map((p) =>
					`- ${p.name} (${p.code}): カテゴリ${p.category ?? "不明"}, 売上¥${p.totalRevenue.toLocaleString()}, 数量${p.totalQuantity}, 粗利率${p.marginRate}%`
				).join("\n")}\n`
				: "";

			const discoveredList = (ctx.recommendedProducts && ctx.recommendedProducts.length > 0)
				? `\n=== 楽天/Web から発掘された新規実在商品 (TVシグナル基準) ===\n${ctx.recommendedProducts.map((p, i) =>
					`${i + 1}. [${p.source}] ${p.name} — 適合度${p.japan_fit_score}/100, 想定価格${p.estimated_price_jpy}\n   出典: ${p.source_url}\n   シグナル根拠: ${p.signal_basis}`
				).join("\n")}\nこれらは実在する商品です。ライブコマースで取り扱うべき新商品の候補としてプラットフォーム選定の参考にしてください。\n`
				: "";

			return `あなたは日本のライブコマースプラットフォーム専門家です。
以下の情報に基づき、各プラットフォームの詳細分析を行ってください。

=== プラットフォーム基本情報 ===
${formatPlatformRef()}

=== 市場調査結果 ===
${JSON.stringify(outputs.market_research ?? {}, null, 2)}

=== ウェブ検索結果 ===
${ctx.searchSummary}
${productList}
${discoveredList}
${goalSection(ctx)}

以下のJSON形式で出力:
{
  "platforms": [
    {
      "name": "<プラットフォーム名>",
      "fit_score": <0-100>,
      "user_base": "<ユーザー層の詳細>",
      "commission_structure": "<手数料体系の詳細>",
      "strengths": ["<強み1>", "<強み2>"],
      "weaknesses": ["<弱み1>", "<弱み2>"],
      "success_cases": [{"brand": "<ブランド名>", "description": "<取り組み内容>", "result": "<成果>"}],
      "recommended_products": ["<このプラットフォームに適した商品カテゴリ>"],
      "entry_steps": ["<参入ステップ1>", "<ステップ2>"],
      "our_recommended_products": [{"code": "<自社商品コード>", "name": "<商品名>", "reason": "<このプラットフォームに適している理由>"}],
      "search_keywords": ["<このプラットフォームで検索すべきキーワード>"]
    }
  ],
  "comparison_summary": "<プラットフォーム比較の総括>",
  "recommended_priority": ["<優先度順のプラットフォーム名>"]
}

注意:
- 5つのプラットフォーム全てを分析
- success_casesは各プラットフォーム1-3個
- our_recommended_productsは自社商品データから各プラットフォームに最適な商品を1-5個選択（自社商品データがない場合は空配列）
- search_keywordsは各プラットフォームで商品を探すための検索キーワード3-5個
- 全てのテキストは日本語`;
		},
	},
	{
		name: "content_strategy",
		buildPrompt: (ctx, outputs) => `あなたはライブコマースのコンテンツ戦略プランナーです。
以下の分析結果に基づき、プラットフォーム別のコンテンツ戦略を策定してください。

=== プラットフォーム分析結果 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "platforms": [
    {
      "name": "<プラットフォーム名>",
      "broadcast_format": "<推奨配信フォーマット>",
      "optimal_times": ["<最適配信時間帯>"],
      "frequency": "<推奨配信頻度>",
      "host_style": "<推奨ホストスタイル>",
      "content_ideas": [{"title": "<企画名>", "description": "<詳細>", "format": "<形式>"}],
      "engagement_tactics": ["<エンゲージメント施策>"],
      "sample_script_outline": "<サンプルスクリプトの流れ（300-500文字）>"
    }
  ],
  "cross_platform_strategy": "<クロスプラットフォーム連携戦略>"
}

注意:
- 推奨順上位3-5プラットフォームを対象
- content_ideasは各プラットフォーム3-5個
- engagement_tacticsは各プラットフォーム3-5個
- sample_script_outlineは実践的な内容
- 全てのテキストは日本語`,
	},
	{
		name: "execution_plan",
		buildPrompt: (ctx, outputs) => `あなたはライブコマース事業の実行計画策定の専門家です。
以下の全分析結果に基づき、具体的な実行ロードマップを策定してください。

=== 市場調査 ===
${JSON.stringify(outputs.market_research ?? {}, null, 2)}

=== プラットフォーム分析 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

=== コンテンツ戦略 ===
${JSON.stringify(outputs.content_strategy ?? {}, null, 2)}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "phases": [
    {
      "phase": "<フェーズ名>",
      "period": "<期間>",
      "objectives": ["<目標>"],
      "actions": [{"action": "<アクション>", "owner": "<担当>", "deadline": "<期限>"}],
      "budget": "<予算>",
      "kpis": [{"metric": "<KPI名>", "target": "<目標値>"}]
    }
  ],
  "total_investment": "<初年度総投資額>",
  "staffing": [{"role": "<役割>", "type": "<正社員/業務委託/パート>", "timing": "<採用時期>"}],
  "tools_and_services": [{"name": "<ツール名>", "purpose": "<用途>", "cost": "<月額費用>"}]
}

注意:
- 3-4フェーズ（準備期、立ち上げ期、成長期、拡大期）
- actionsは各フェーズ3-5個
- kpisは各フェーズ2-4個
- 全てのテキストは日本語
- 具体的な数字を含める`,
	},
	{
		name: "risk_analysis",
		buildPrompt: (ctx, outputs) => `あなたはライブコマース事業のリスク管理専門家です。
以下の全分析結果に基づき、リスク分析と対策を策定してください。

=== 実行計画 ===
${JSON.stringify(outputs.execution_plan ?? {}, null, 2)}

=== プラットフォーム分析 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "risks": [
    {
      "category": "<リスクカテゴリ: 市場/運営/技術/法規制/財務/競合>",
      "description": "<リスク内容>",
      "severity": "<high/medium/low>",
      "probability": "<high/medium/low>",
      "mitigation": "<軽減策>"
    }
  ],
  "contingency_plans": [{"scenario": "<最悪のシナリオ>", "response": "<対応策>"}],
  "success_factors": ["<成功の重要要因>"]
}

注意:
- risksは8-12個
- contingency_plansは3-5個
- success_factorsは5-7個
- 全てのテキストは日本語`,
	},
];

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

// Public single-skill runner used by the workflow path.
export async function runLCSkill(
	skillName: LCSkillName,
	context: LCContext,
	priorOutputs: Record<string, unknown>,
): Promise<unknown> {
	if (skillName === "goal_analysis") {
		if (!context.userGoal) {
			return {
				primary_objective: "日本市場でのライブコマース事業参入の全体戦略策定",
				target_platforms: context.targetPlatforms ?? ["TikTok Live", "Instagram Live", "YouTube Live"],
			} as ParsedGoal;
		}
		return await runGoalAnalysis(context.userGoal);
	}
	const skill = SKILL_PIPELINE.find((s) => s.name === skillName);
	if (!skill) throw new Error(`Unknown LC skill: ${skillName}`);
	const prompt = skill.buildPrompt(context, priorOutputs);
	const raw = await callGemini(prompt);
	const parsed = parseJSON<Record<string, unknown>>(raw);
	if (skillName === "platform_analysis" && context.recommendedProducts && context.recommendedProducts.length > 0) {
		const pa = parsed as unknown as PlatformAnalysisOutput;
		pa.discovered_new_products = context.recommendedProducts;
		pa.discovery_history = [{
			generatedAt: new Date().toISOString(),
			products: context.recommendedProducts,
		}];
	}
	return parsed;
}

export const LC_SKILL_NAMES: LCSkillName[] = [
	"goal_analysis",
	"market_research",
	"platform_analysis",
	"content_strategy",
	"execution_plan",
	"risk_analysis",
];

export async function runLCOrchestrator(
	context: LCContext,
	onProgress: (event: LCProgressEvent) => void,
): Promise<FullLCStrategyResult> {
	const outputs: Record<string, unknown> = {};

	for (let i = 0; i < SKILL_PIPELINE.length; i++) {
		const skill = SKILL_PIPELINE[i];
		onProgress({ skill: skill.name, status: "running", index: i, total: SKILL_PIPELINE.length });

		try {
			if (skill.name === "goal_analysis") {
				if (context.userGoal) {
					const parsedGoal = await runGoalAnalysis(context.userGoal);
					context.parsedGoal = parsedGoal;
					outputs.goal_analysis = parsedGoal;

					// Run dynamic queries based on parsed goal
					const dynamicQueries = buildDynamicQueries(parsedGoal);
					if (dynamicQueries.length > 0) {
						const dynamicResults = await Promise.all(dynamicQueries.map((q) => braveSearch(q)));
						const newSources = dynamicResults.flat();
						context.searchSources.push(...newSources);
						context.searchSummary += "\n\n" + newSources
							.map((s, idx) => `[${context.searchSources.length - newSources.length + idx + 1}] ${s.title}\n${s.description}\n(${s.url})`)
							.join("\n\n");
					}

					onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: parsedGoal });
				} else {
					const defaultGoal: ParsedGoal = {
						primary_objective: "日本市場でのライブコマース事業参入の全体戦略策定",
						target_platforms: context.targetPlatforms ?? ["TikTok Live", "Instagram Live", "YouTube Live"],
					};
					context.parsedGoal = defaultGoal;
					outputs.goal_analysis = defaultGoal;
					onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: defaultGoal });
				}
				continue;
			}

			if (skill.name === "platform_analysis" && context.recommendedProductsPromise) {
				context.recommendedProducts = await context.recommendedProductsPromise;
				context.recommendedProductsPromise = undefined;
			}
			const prompt = skill.buildPrompt(context, outputs);
			const raw = await callGemini(prompt);
			const parsed = parseJSON<Record<string, unknown>>(raw);

			// Inject discovered new products into platform_analysis output
			// so the UI can render them as a top-level "発掘新商品" section.
			if (skill.name === "platform_analysis") {
				if (context.recommendedProducts && context.recommendedProducts.length > 0) {
					const pa = parsed as unknown as PlatformAnalysisOutput;
					pa.discovered_new_products = context.recommendedProducts;
					pa.discovery_history = [{
						generatedAt: new Date().toISOString(),
						products: context.recommendedProducts,
					}];
					console.log(`[lc-orchestrator] spliced ${context.recommendedProducts.length} discovered products into platform_analysis`);
				} else {
					console.warn(`[lc-orchestrator] context.recommendedProducts is empty/undefined — no hero will render`);
				}
			}

			outputs[skill.name] = parsed;
			onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: parsed });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			onProgress({ skill: skill.name, status: "error", index: i, total: SKILL_PIPELINE.length, error: message });
			outputs[skill.name] = {};
		}
	}

	return outputs as unknown as FullLCStrategyResult;
}
