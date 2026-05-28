import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { GEMINI_MODELS_WITH_FALLBACK } from "@/lib/gemini-models";
import { getServiceClient } from "@/lib/supabase";
import { discoverNewProducts, type DiscoveredProduct, type DiscoveryBatch } from "@/lib/md-strategy";
import type { SeedContext } from "@/lib/strategy/seed-context";
import { formatSeedPromptSection } from "@/lib/strategy/seed-context";
import type { IntentTier, ChannelScope, SpecificKeyword } from "@/lib/strategy/discover-intent";
import { ensureDiscoverIntent } from "@/lib/strategy/discover-intent";
import { isPhase05Enabled } from "@/lib/strategy/feature-flags";
import { filterAliases } from "@/lib/strategy/alias-blocklist";
import { resolveChannelSlug } from "@/lib/strategy/channel-aliases";

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

// Lazy SDK init — see md-strategy.ts for rationale (workflow sandbox safety).
let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
	if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	return _genAI;
}

// Gemini 3 family only. Flash-preview default, pro-preview fallback.
// Ref: https://ai.google.dev/gemini-api/docs/gemini-3
const GEMINI_MODELS = GEMINI_MODELS_WITH_FALLBACK;

function isRetryableGeminiError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message;
	return (
		msg.includes("503") || msg.includes("429") || msg.includes("500") || msg.includes("502") || msg.includes("504") ||
		msg.includes("overloaded") || msg.includes("Service Unavailable") || msg.includes("UNAVAILABLE") ||
		msg.includes("aborted") || msg.includes("timeout") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")
	);
}

async function callGeminiOnce(modelName: string, prompt: string): Promise<string> {
	const HARD_TIMEOUT_MS = 240_000;
	const FIRST_CHUNK_MS = 120_000;
	const startTs = Date.now();
	const controller = new AbortController();
	const hardTimer = setTimeout(
		() => controller.abort(new Error(`Gemini hard timeout ${HARD_TIMEOUT_MS}ms`)),
		HARD_TIMEOUT_MS,
	);
	let firstChunkTimer: ReturnType<typeof setTimeout> | null = setTimeout(
		() => controller.abort(new Error(`Gemini first-chunk timeout ${FIRST_CHUNK_MS}ms`)),
		FIRST_CHUNK_MS,
	);
	const thinkingLevel = modelName.includes("pro") ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL;
	try {
		const stream = await getGenAI().models.generateContentStream({
			model: modelName,
			contents: prompt,
			config: {
				thinkingConfig: { thinkingLevel },
				abortSignal: controller.signal,
			},
		});
		let text = "";
		let chunks = 0;
		for await (const chunk of stream) {
			if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }
			const t = chunk.text ?? "";
			text += t;
			chunks++;
			if (chunks % 20 === 0) {
				console.log(`[gemini-lc ${modelName}] streamed ${chunks} chunks (${text.length} chars) at ${Math.round((Date.now() - startTs) / 1000)}s`);
			}
		}
		console.log(`[gemini-lc ${modelName}] stream complete: ${chunks} chunks, ${text.length} chars in ${Math.round((Date.now() - startTs) / 1000)}s`);
		return text.trim();
	} finally {
		clearTimeout(hardTimer);
		if (firstChunkTimer) clearTimeout(firstChunkTimer);
	}
}

function isModelUnavailableError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message;
	return msg.includes("404") || msg.includes("Not Found") || msg.includes("no longer available") || msg.includes("not found");
}

async function callGemini(prompt: string): Promise<string> {
	let lastErr: unknown = null;
	for (const modelName of GEMINI_MODELS) {
		let modelDead = false;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await callGeminiOnce(modelName, prompt);
			} catch (err) {
				lastErr = err;
				if (isModelUnavailableError(err)) {
					console.warn(`[gemini-lc] model ${modelName} unavailable (${(err as Error).message}) — skipping to next.`);
					modelDead = true;
					break;
				}
				if (!isRetryableGeminiError(err)) throw err;
				const delayMs = 2000 * Math.pow(2, attempt);
				console.warn(`[gemini-lc ${modelName}] attempt ${attempt + 1}/3 failed (retryable): ${(err as Error).message}. Retrying in ${delayMs}ms.`);
				await new Promise((r) => setTimeout(r, delayMs));
			}
		}
		if (!modelDead) {
			console.warn(`[gemini-lc] model ${modelName} exhausted retries — falling back to next model.`);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error("All Gemini models failed");
}

function parseJSON<T>(raw: string): T {
	let cleaned = raw.trim();
	const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fenceMatch) cleaned = fenceMatch[1].trim();
	try { return JSON.parse(cleaned) as T; } catch { /* fallthrough */ }
	const objStart = cleaned.indexOf("{");
	const arrStart = cleaned.indexOf("[");
	if (objStart === -1 && arrStart === -1) {
		throw new Error(`Failed to parse JSON (no { or [). Head: ${cleaned.slice(0, 200)}`);
	}
	let start: number, openCh: string, closeCh: string;
	if (arrStart === -1 || (objStart !== -1 && objStart < arrStart)) {
		start = objStart; openCh = "{"; closeCh = "}";
	} else {
		start = arrStart; openCh = "["; closeCh = "]";
	}
	let depth = 0, inString = false, escape = false, end = -1;
	for (let i = start; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (escape) { escape = false; continue; }
		if (ch === "\\") { escape = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === openCh) depth++;
		else if (ch === closeCh) { depth--; if (depth === 0) { end = i; break; } }
	}
	if (end === -1) throw new Error(`Failed to parse JSON (unbalanced ${openCh}). Head: ${cleaned.slice(0, 200)}`);
	const slice = cleaned.slice(start, end + 1);
	try { return JSON.parse(slice) as T; }
	catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse JSON: ${msg}. Slice head: ${slice.slice(0, 200)}`);
	}
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
	skill: LCSkillName | "data_fetch" | "new_product_discovery";
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
	// DiscoverIntent fields — mirror MD `ParsedGoal` so both pipelines feed
	// the shared discoverNewProducts intent pathway uniformly.
	seasonal_keywords: string[];
	theme_keywords: string[];
	category_hints: string[];
	excluded_themes: string[];
	// SearchIntent classifier fields (Phase 0.5) — mirrors MD ParsedGoal.
	// Required at the type level (legacy/partial inputs flow through the
	// `projectParsedGoalToIntent` projector which fills defaults).
	intent_tier: IntentTier;
	channel_scope: ChannelScope[];
	specific_keyword: SpecificKeyword | null;
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
	const platforms = Array.isArray(goal.target_platforms) ? goal.target_platforms : [];
	for (const platform of platforms.slice(0, 2)) {
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
	// Signals derived at fetch time, consumed by the final discovery step.
	topCategoryNames?: string[];
	avgMarginRate?: number;
	seedProduct?: SeedContext;
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

	// Discovery is deferred to a final workflow step (after all analysis skills run).
	return {
		userGoal,
		targetPlatforms,
		searchSources: allSources,
		searchSummary,
		products: productResult,
		// Expose derived signals for the final discovery step.
		topCategoryNames,
		avgMarginRate,
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

export function buildLCGoalPromptLegacy(userGoal: string): string {
	return `あなたはライブコマース戦略コンサルタントです。以下のユーザー目標を構造化し、商品発掘の方向性 (季節/テーマ/カテゴリ) も抽出してください。

ユーザー入力: "${userGoal}"

以下のJSON形式で出力:
{
  "primary_objective": "<主な目的を1-2文で>",
  "target_platforms": ["<プラットフォーム名>"],
  "budget_range": "<予算範囲（言及がなければnull）>",
  "timeline": "<タイムライン（言及がなければnull）>",
  "target_audience": "<ターゲット層（言及がなければnull）>",
  "seasonal_keywords": ["季節/タイミングを表す短い日本語キーワード"],
  "theme_keywords": ["商品テーマを表す短い日本語キーワード"],
  "category_hints": ["想定される具体的な商品カテゴリ (日本語)"],
  "excluded_themes": ["目標と矛盾するため除外すべきテーマ"]
}

EXTRACTION RULES:
- seasonal_keywords: 「冬/夏/春/秋/年末/年始/クリスマス/ハロウィン/バレンタイン/お歳暮/お中元/梅雨/花粉/新生活/防災」など。明示・含意どちらでも拾う。なければ []。
- theme_keywords: 「暖かい/防寒/時短/ギフト/健康/美容/節約」など、商品の訴求軸を表す短語。なければ []。
- category_hints: 楽天やAmazonで検索した時にヒットする粒度のカテゴリ語 (例: 「暖房家電」「鍋・キッチン家電」「美容家電」「ホットカーペット」)。3〜6個推奨。なければ []。
- excluded_themes: ユーザー目標と明らかに矛盾するもの (例: 「冬」目標→["扇風機", "夏物"])。なければ []。

注意:
- primary_objective は必ず文字列で返してください。
- target_platforms は必ず配列で返してください（null は使わない）。明示されていない場合は ["TikTok Live", "Instagram Live", "YouTube Live"] をデフォルトとして返してください。
- budget_range / timeline / target_audience は言及がなければ null を返してください。
- seasonal_keywords / theme_keywords / category_hints / excluded_themes は必ず配列 (空でも []) を返してください。
- 全てのテキストは日本語で出力`;
}

export function buildLCGoalPromptExtended(userGoal: string): string {
	return `あなたはライブコマース戦略コンサルタントです。以下のユーザー目標を構造化し、商品発掘の方向性 (季節/テーマ/カテゴリ) と検索の粒度 (tier/channel scope/specific keyword) も抽出してください。

ユーザー入力: "${userGoal}"

以下のJSON形式で出力:
{
  "primary_objective": "<主な目的を1-2文で>",
  "target_platforms": ["<プラットフォーム名>"],
  "budget_range": "<予算範囲（言及がなければnull）>",
  "timeline": "<タイムライン（言及がなければnull）>",
  "target_audience": "<ターゲット層（言及がなければnull）>",
  "seasonal_keywords": ["季節/タイミングを表す短い日本語キーワード"],
  "theme_keywords": ["商品テーマを表す短い日本語キーワード"],
  "category_hints": ["想定される具体的な商品カテゴリ (日本語)"],
  "excluded_themes": ["目標と矛盾するため除外すべきテーマ"],
  "intent_tier": "broad" | "seasonal" | "genre" | "specific_keyword",
  "channel_scope": [{"channel_slug": "...", "raw_mention": "...", "confidence": 0.0-1.0}],
  "specific_keyword": {"raw": "...", "normalized": "...", "aliases": ["...(max 6)"], "confidence": 0.0-1.0} | null
}

EXTRACTION RULES:
- seasonal_keywords: 「冬/夏/春/秋/年末/年始/クリスマス/ハロウィン/バレンタイン/お歳暮/お中元/梅雨/花粉/新生活/防災」など。
- theme_keywords: 「暖かい/防寒/時短/ギフト/健康/美容/節約」など、商品の訴求軸を表す短語。
- category_hints: 楽天やAmazonで検索した時にヒットする粒度のカテゴリ語 (3〜6個推奨)。
- excluded_themes: ユーザー目標と明らかに矛盾するもの。
- intent_tier:
  * "specific_keyword": 特定の単一品目名が明示された場合 (包丁/ホットカーペット/EMS 等)。
  * "genre": 広域カテゴリのみ指定 (フィットネス/美容家電 等)。
  * "seasonal": 季節/イベントのみ指定 (冬の商品/お歳暮 等)。
  * "broad": 上記いずれにも該当しない (「人気の商品」「売れている商品」等)。
  複合シグナルは最も narrow な tier を選ぶ。他の軸 (季節 + チャネル等) は同時に他フィールドへ抽出する。
- channel_scope.confidence: ライブコマースプラットフォーム名 (TikTok Live / Instagram Live / YouTube Live 等) の正確な一致→1.0、表記揺れ→0.8、曖昧→<0.5 (<0.5 は出力しない)。
- specific_keyword.confidence: 単一の narrow な品目名→≥0.9、広いカテゴリを品目と誤認した場合→<0.7。
- specific_keyword.aliases:
  * 最大6個まで、カタカナ/ひらがな/英語/中国漢字の同義語を含める。
  * 広いカテゴリ語 (キッチン用品/家電/服 等) は絶対に含めない。
  * 例: 包丁 → ["ナイフ","knife","キッチンナイフ","三徳包丁","菜切り","ペティナイフ"]

EXAMPLES:
- 「TikTok Liveで売れる包丁」 →
  intent_tier: "specific_keyword"
  channel_scope: [{"channel_slug":"tiktok_live","raw_mention":"TikTok Live","confidence":0.9}]
  specific_keyword: {"raw":"包丁","normalized":"包丁","aliases":["ナイフ","knife","キッチンナイフ","三徳包丁","菜切り","ペティナイフ"],"confidence":0.95}

- 「冬に売れる暖房家電のライブ配信」 →
  intent_tier: "genre"
  channel_scope: []
  specific_keyword: null
  seasonal_keywords: ["冬"]
  category_hints: ["暖房家電","ヒーター","電気ストーブ"]

注意:
- primary_objective は必ず文字列で返してください。
- target_platforms は必ず配列で返してください（null は使わない）。明示されていない場合は ["TikTok Live", "Instagram Live", "YouTube Live"] をデフォルトとして返してください。
- budget_range / timeline / target_audience は言及がなければ null を返してください。
- 配列は null ではなく [] を返す。
- 全てのテキストは日本語で出力。`;
}

// Backward-compatible re-export so existing callers (tests, etc.) keep working.
export function buildLCGoalAnalysisPrompt(userGoal: string): string {
	return isPhase05Enabled() ? buildLCGoalPromptExtended(userGoal) : buildLCGoalPromptLegacy(userGoal);
}

export async function runLCGoalAnalysis(userGoal: string): Promise<ParsedGoal> {
	const useExtended = isPhase05Enabled();
	const prompt = useExtended ? buildLCGoalPromptExtended(userGoal) : buildLCGoalPromptLegacy(userGoal);

	const raw = await callGemini(prompt);
	const parsed = parseJSON<Partial<ParsedGoal>>(raw);
	const platforms = Array.isArray(parsed.target_platforms)
		? parsed.target_platforms.filter((p): p is string => typeof p === "string")
		: [];
	const intent = ensureDiscoverIntent(
		{
			seasonal_keywords: Array.isArray(parsed.seasonal_keywords) ? parsed.seasonal_keywords : [],
			theme_keywords: Array.isArray(parsed.theme_keywords) ? parsed.theme_keywords : [],
			category_hints: Array.isArray(parsed.category_hints) ? parsed.category_hints : [],
			excluded_themes: Array.isArray(parsed.excluded_themes) ? parsed.excluded_themes : [],
		},
		userGoal,
	);

	// Phase 0.5 extraction (only when flag on AND gemini returned the new fields)
	let intent_tier: ParsedGoal["intent_tier"] = "broad";
	let channel_scope: ParsedGoal["channel_scope"] = [];
	let specific_keyword: ParsedGoal["specific_keyword"] = null;

	if (useExtended) {
		const tier = parsed.intent_tier;
		if (tier === "broad" || tier === "seasonal" || tier === "genre" || tier === "specific_keyword") {
			intent_tier = tier;
		}

		if (Array.isArray(parsed.channel_scope)) {
			channel_scope = parsed.channel_scope
				.map((c: any) => {
					const slug = resolveChannelSlug(c?.raw_mention ?? c?.channel_slug ?? "");
					if (!slug) return null;
					const conf = typeof c?.confidence === "number" ? c.confidence : 0;
					if (conf < 0.5) return null;
					return { channel_slug: slug, raw_mention: c.raw_mention ?? slug, confidence: conf };
				})
				.filter((x: any): x is NonNullable<typeof x> => x !== null)
				.slice(0, 5);
		}

		if (parsed.specific_keyword && parsed.specific_keyword.normalized) {
			const rawSk = parsed.specific_keyword.raw ?? parsed.specific_keyword.normalized;
			const normalized = parsed.specific_keyword.normalized;
			const rawAliases = Array.isArray(parsed.specific_keyword.aliases)
				? parsed.specific_keyword.aliases.filter((s: any): s is string => typeof s === "string")
				: [];
			const conf = typeof parsed.specific_keyword.confidence === "number" ? parsed.specific_keyword.confidence : 0;

			const { kept, dropped } = filterAliases(rawAliases, intent.category_hints);
			if (dropped.length > 0) {
				console.warn(`[lc-goal-analysis] alias guard dropped ${dropped.length}: ${dropped.join(", ")}`);
			}

			if (conf >= 0.7) {
				specific_keyword = { raw: rawSk, normalized, aliases: kept.slice(0, 6), confidence: conf };
			} else {
				console.warn(`[lc-goal-analysis] specific_keyword confidence ${conf} < 0.7, downgrading tier to 'genre'`);
				if (intent_tier === "specific_keyword") intent_tier = "genre";
				specific_keyword = null;
			}
		}
	}

	const result: ParsedGoal = {
		primary_objective: typeof parsed.primary_objective === "string" ? parsed.primary_objective : "",
		target_platforms: platforms.length > 0 ? platforms : ["TikTok Live", "Instagram Live", "YouTube Live"],
		budget_range: typeof parsed.budget_range === "string" ? parsed.budget_range : undefined,
		timeline: typeof parsed.timeline === "string" ? parsed.timeline : undefined,
		target_audience: typeof parsed.target_audience === "string" ? parsed.target_audience : undefined,
		seasonal_keywords: intent.seasonal_keywords,
		theme_keywords: intent.theme_keywords,
		category_hints: intent.category_hints,
		excluded_themes: intent.excluded_themes,
		intent_tier,
		channel_scope,
		specific_keyword,
	};

	console.log(`[lc-goal-analysis] userGoal="${userGoal.slice(0, 60)}" tier=${intent_tier} channels=[${channel_scope.map((c) => c.channel_slug).join(",")}] specific="${specific_keyword?.normalized ?? "—"}" confidence=${specific_keyword?.confidence ?? "—"}`);

	return result;
}

// Internal alias preserved to minimize churn at the two existing call sites
// (runLCSkill, runLCOrchestrator) below.
const runGoalAnalysis = runLCGoalAnalysis;

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
	const platforms = Array.isArray(g.target_platforms) ? g.target_platforms : [];
	return `
=== ユーザー目標 ===
- 主な目的: ${g.primary_objective || "（未指定）"}
${platforms.length > 0 ? `- 対象プラットフォーム: ${platforms.join(", ")}` : ""}
${g.budget_range ? `- 予算: ${g.budget_range}` : ""}
${g.timeline ? `- タイムライン: ${g.timeline}` : ""}
${g.target_audience ? `- ターゲット層: ${g.target_audience}` : ""}
上記の目標を全ての分析で最優先に考慮してください。
`;
}

// Per-skill prompt builders, extracted from the previous inline arrow functions
// so the registry layer can import them by name. Behavior byte-for-byte identical.

export function buildLCMarketResearchPrompt(ctx: LCContext, _outputs: Record<string, unknown>): string {
	const seedSection = formatSeedPromptSection(ctx.seedProduct ?? null);
	return `あなたは日本のライブコマース市場の専門アナリストです。
以下のウェブ検索結果に基づき、日本のライブコマース市場を分析してください。

=== ウェブ検索結果 ===
${ctx.searchSummary}

${goalSection(ctx)}
${seedSection}
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
- ウェブ検索結果を根拠として活用し、sources_referencedで番号を記載`;
}

export function buildLCPlatformAnalysisPrompt(ctx: LCContext, outputs: Record<string, unknown>): string {
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

	const seedSection = formatSeedPromptSection(ctx.seedProduct ?? null);

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
${seedSection}
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
}

export function buildLCContentStrategyPrompt(ctx: LCContext, outputs: Record<string, unknown>): string {
	const seedSection = formatSeedPromptSection(ctx.seedProduct ?? null);
	return `あなたはライブコマースのコンテンツ戦略プランナーです。
以下の分析結果に基づき、プラットフォーム別のコンテンツ戦略を策定してください。

=== プラットフォーム分析結果 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

${goalSection(ctx)}
${seedSection}
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
- 全てのテキストは日本語`;
}

export function buildLCExecutionPlanPrompt(ctx: LCContext, outputs: Record<string, unknown>): string {
	const seedSection = formatSeedPromptSection(ctx.seedProduct ?? null);
	return `あなたはライブコマース事業の実行計画策定の専門家です。
以下の全分析結果に基づき、具体的な実行ロードマップを策定してください。

=== 市場調査 ===
${JSON.stringify(outputs.market_research ?? {}, null, 2)}

=== プラットフォーム分析 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

=== コンテンツ戦略 ===
${JSON.stringify(outputs.content_strategy ?? {}, null, 2)}

${goalSection(ctx)}
${seedSection}
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
- 具体的な数字を含める`;
}

export function buildLCRiskAnalysisPrompt(ctx: LCContext, outputs: Record<string, unknown>): string {
	const seedSection = formatSeedPromptSection(ctx.seedProduct ?? null);
	return `あなたはライブコマース事業のリスク管理専門家です。
以下の全分析結果に基づき、リスク分析と対策を策定してください。

=== 実行計画 ===
${JSON.stringify(outputs.execution_plan ?? {}, null, 2)}

=== プラットフォーム分析 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

${goalSection(ctx)}
${seedSection}
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
- 全てのテキストは日本語`;
}

const SKILL_PIPELINE: SkillDef[] = [
	{ name: "goal_analysis", buildPrompt: () => "" },
	{ name: "market_research", buildPrompt: buildLCMarketResearchPrompt },
	{ name: "platform_analysis", buildPrompt: buildLCPlatformAnalysisPrompt },
	{ name: "content_strategy", buildPrompt: buildLCContentStrategyPrompt },
	{ name: "execution_plan", buildPrompt: buildLCExecutionPlanPrompt },
	{ name: "risk_analysis", buildPrompt: buildLCRiskAnalysisPrompt },
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
		// Short-circuit: if pre-run already populated ctx.parsedGoal, reuse it
		if (context.parsedGoal) {
			return context.parsedGoal;
		}
		if (!context.userGoal) {
			const fallback: ParsedGoal = {
				primary_objective: "日本市場でのライブコマース事業参入の全体戦略策定",
				target_platforms: context.targetPlatforms ?? ["TikTok Live", "Instagram Live", "YouTube Live"],
				seasonal_keywords: [],
				theme_keywords: [],
				category_hints: [],
				excluded_themes: [],
				intent_tier: "broad",
				channel_scope: [],
				specific_keyword: null,
			};
			return fallback;
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
						seasonal_keywords: [],
						theme_keywords: [],
						category_hints: [],
						excluded_themes: [],
						intent_tier: "broad",
						channel_scope: [],
						specific_keyword: null,
					};
					context.parsedGoal = defaultGoal;
					outputs.goal_analysis = defaultGoal;
					onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: defaultGoal });
				}
				continue;
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
