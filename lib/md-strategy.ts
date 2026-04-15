import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { getServiceClient } from "@/lib/supabase";
import { rakutenItemSearch, rakutenRankingSearch } from "@/lib/rakuten";
import { formatProfileForPrompt } from "@/lib/tv-shopping-profile";
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

// Lazy SDK init — avoid top-level construction (workflow sandbox safety).
let _genAI: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
	if (!_genAI) _genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
	return _genAI;
}

// Gemini 3 family only. Flash-preview is the default; pro-preview is the high-quality
// fallback when flash is overloaded (503). Ref: https://ai.google.dev/gemini-api/docs/gemini-3
const GEMINI_MODELS = ["gemini-3-flash-preview", "gemini-3.1-pro-preview"];

function isRetryableGeminiError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message;
	// Network/quota/overload + our own first-chunk/hard timeouts (which abort the fetch).
	return (
		msg.includes("503") ||
		msg.includes("429") ||
		msg.includes("500") ||
		msg.includes("502") ||
		msg.includes("504") ||
		msg.includes("overloaded") ||
		msg.includes("Service Unavailable") ||
		msg.includes("UNAVAILABLE") ||
		msg.includes("aborted") ||
		msg.includes("timeout") ||
		msg.includes("ECONNRESET") ||
		msg.includes("ETIMEDOUT")
	);
}

async function callGeminiOnce(modelName: string, prompt: string): Promise<string> {
	// Gemini 3 with thinking mode does significant server-side thinking BEFORE streaming
	// any output. For large prompts (product_selection, channel_strategy) the first byte
	// can take 30-90s. Keep first-chunk watchdog generous to avoid false aborts.
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
	// Minimal thinking for flash (fast first byte), medium for pro (quality fallback).
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
				console.log(`[gemini ${modelName}] streamed ${chunks} chunks (${text.length} chars) at ${Math.round((Date.now() - startTs) / 1000)}s`);
			}
		}
		console.log(`[gemini ${modelName}] stream complete: ${chunks} chunks, ${text.length} chars in ${Math.round((Date.now() - startTs) / 1000)}s`);
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
					// Model gone — retry same model is pointless, jump to next model.
					console.warn(`[gemini] model ${modelName} unavailable (${(err as Error).message}) — skipping to next.`);
					modelDead = true;
					break;
				}
				if (!isRetryableGeminiError(err)) {
					// Hard error (auth, prompt too long, invalid key) — don't try other models either.
					throw err;
				}
				const delayMs = 2000 * Math.pow(2, attempt);
				console.warn(`[gemini ${modelName}] attempt ${attempt + 1}/3 failed (retryable): ${(err as Error).message}. Retrying in ${delayMs}ms.`);
				await new Promise((r) => setTimeout(r, delayMs));
			}
		}
		if (!modelDead) {
			console.warn(`[gemini] model ${modelName} exhausted retries — falling back to next model.`);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error("All Gemini models failed");
}

function parseJSON<T>(raw: string): T {
	// Strip markdown code fences (```json ... ``` or ``` ... ```) that fallback models often add.
	let cleaned = raw.trim();
	const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fenceMatch) cleaned = fenceMatch[1].trim();
	// Try direct parse first.
	try {
		return JSON.parse(cleaned) as T;
	} catch { /* fall through to extraction */ }
	// Extract first JSON object OR array from the text.
	const objStart = cleaned.indexOf("{");
	const arrStart = cleaned.indexOf("[");
	let start = -1;
	let openCh = "";
	let closeCh = "";
	if (objStart === -1 && arrStart === -1) {
		throw new Error(`Failed to parse JSON from Gemini response (no { or [). Head: ${cleaned.slice(0, 200)}`);
	}
	if (arrStart === -1 || (objStart !== -1 && objStart < arrStart)) {
		start = objStart; openCh = "{"; closeCh = "}";
	} else {
		start = arrStart; openCh = "["; closeCh = "]";
	}
	// Walk forward tracking nesting to find the matching close (handles strings/escapes).
	let depth = 0;
	let inString = false;
	let escape = false;
	let end = -1;
	for (let i = start; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (escape) { escape = false; continue; }
		if (ch === "\\") { escape = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === openCh) depth++;
		else if (ch === closeCh) {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end === -1) {
		throw new Error(`Failed to parse JSON from Gemini response (unbalanced ${openCh}). Head: ${cleaned.slice(0, 200)}`);
	}
	const slice = cleaned.slice(start, end + 1);
	try {
		return JSON.parse(slice) as T;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse JSON: ${msg}. Slice head: ${slice.slice(0, 200)}`);
	}
}

// ---------------------------------------------------------------------------
// Brave Search (structured results with URLs)
// ---------------------------------------------------------------------------

export interface SearchSource {
	title: string;
	url: string;
	description: string;
	query: string;
}

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

async function braveSearchStructured(query: string): Promise<SearchSource[]> {
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
// Channel Reference Table (hardcoded facts — no Gemini lookup needed)
// ---------------------------------------------------------------------------

const CHANNEL_REFERENCE = [
	{ name: "Amazon Japan", commission: "8-15%", monthlyFee: "¥4,900", fulfillment: "FBA: ¥500-1,000/個", initialCost: "¥10-30万", setupTime: "2-4週間" },
	{ name: "楽天市場", commission: "3.5-7%", monthlyFee: "¥19,500-100,000", fulfillment: "RSL or 自社出荷", initialCost: "¥30-100万", setupTime: "1-2ヶ月" },
	{ name: "Yahoo!ショッピング", commission: "3-5%", monthlyFee: "無料", fulfillment: "自社出荷", initialCost: "¥5-15万", setupTime: "1-2週間" },
	{ name: "TikTok Shop Japan", commission: "5-8%", monthlyFee: "無料", fulfillment: "自社出荷", initialCost: "¥5-10万", setupTime: "2-4週間" },
	{ name: "Instagram Shopping", commission: "5%", monthlyFee: "無料", fulfillment: "自社出荷", initialCost: "¥3-5万", setupTime: "1-2週間" },
	{ name: "越境EC (Coupang/Shopee)", commission: "10-15%", monthlyFee: "変動", fulfillment: "現地倉庫", initialCost: "¥50-200万", setupTime: "2-3ヶ月" },
	{ name: "自社EC (D2C)", commission: "決済3-4%", monthlyFee: "¥10,000-50,000", fulfillment: "自社出荷", initialCost: "¥50-300万", setupTime: "2-4ヶ月" },
] as const;

// ---------------------------------------------------------------------------
// Category mapping for filtering
// ---------------------------------------------------------------------------

const CATEGORY_MAPPING: Record<string, string[]> = {
	"美容・スキンケア": ["美容・運動", "化粧品"],
	"健康食品": ["食品"],
	"キッチン用品": ["キッチン"],
	"ファッション": ["アパレル", "靴・バッグ"],
	"生活雑貨": ["家電・雑貨", "掃除・洗濯"],
	"電気機器": ["家電・雑貨"],
	"フィットネス": ["美容・運動", "医療機器"],
	"その他": ["その他", "寝具", "宝飾", "防災・防犯", "ゴルフ"],
};

// ---------------------------------------------------------------------------
// Parsed Goal (Skill 0 output)
// ---------------------------------------------------------------------------

export interface ParsedGoal {
	primary_objective: string;
	target_channels: string[];
	target_revenue?: string;
	target_audience?: string;
	budget_constraint?: string;
	timeline?: string;
}

// ---------------------------------------------------------------------------
// Computed Metrics (pre-computed for each product)
// ---------------------------------------------------------------------------

interface ComputedMetrics {
	tvUnitPrice: number;
	monthlyGrowthRate: number;
	trajectory: "growing" | "stable" | "declining";
	ecMarginAfterFees: number;
	seasonalPeak: string;
	seasonalLow: string;
	skuCount: number;
	priceRange: string;
	hasEcPresence: boolean;
}

function computeMetrics(p: EnrichedProduct): ComputedMetrics {
	const tvUnitPrice = p.totalQuantity > 0 ? Math.round(p.totalRevenue / p.totalQuantity) : 0;

	// Monthly growth rate: % change over last 3 months
	let monthlyGrowthRate = 0;
	if (p.monthlyTrend.length >= 3) {
		const recent3 = p.monthlyTrend.slice(-3);
		const first = recent3[0].revenue;
		const last = recent3[2].revenue;
		if (first > 0) monthlyGrowthRate = Math.round(((last - first) / first) * 10000) / 100;
	}

	let trajectory: "growing" | "stable" | "declining" = "stable";
	if (monthlyGrowthRate > 10) trajectory = "growing";
	else if (monthlyGrowthRate < -10) trajectory = "declining";

	// EC margin after 15% commission (only calculate if actual cost_price exists)
	let ecMarginAfterFees = 0;
	if (p.costPrice != null && tvUnitPrice > 0) {
		ecMarginAfterFees = Math.round(((tvUnitPrice - p.costPrice - tvUnitPrice * 0.15) / tvUnitPrice) * 10000) / 100;
	} else if (tvUnitPrice > 0 && p.marginRate > 0) {
		// Approximate: assume TV margin minus 15% EC fee
		ecMarginAfterFees = Math.round((p.marginRate - 15) * 100) / 100;
	}

	// Seasonality peak and low
	let seasonalPeak = "-";
	let seasonalLow = "-";
	if (p.research?.seasonality) {
		const entries = Object.entries(p.research.seasonality);
		if (entries.length > 0) {
			entries.sort((a, b) => b[1] - a[1]);
			seasonalPeak = entries.slice(0, 2).map(([m]) => m).join(", ");
			seasonalLow = entries.slice(-2).map(([m]) => m).join(", ");
		}
	}

	// SKU info
	const skuCount = p.skus?.length ?? 0;
	let priceRange = "-";
	if (p.skus?.length) {
		const prices = p.skus.filter((s) => s.price_incl).map((s) => s.price_incl!);
		if (prices.length > 0) {
			priceRange = `¥${Math.min(...prices).toLocaleString()}〜¥${Math.max(...prices).toLocaleString()}`;
		}
	}

	const hasEcPresence = p.salesChannels?.ec ?? false;

	return {
		tvUnitPrice,
		monthlyGrowthRate,
		trajectory,
		ecMarginAfterFees,
		seasonalPeak,
		seasonalLow,
		skuCount,
		priceRange,
		hasEcPresence,
	};
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
	// Newly-discovered products from real Rakuten/Brave searches, curated by Gemini
	recommendedProducts?: Array<{
		name: string;
		reason: string;
		japan_fit_score: number;
		estimated_demand: string;
		supply_source: string;
		estimated_price_jpy: string;
		source: "rakuten" | "web";
		source_url: string;
		ranking_info?: string;
		signal_basis: string;
		japan_market_fit: {
			popularity_evidence: string;
			trend_context: string;
			why_japan_now: string;
			review_signal?: string;
		};
		sales_strategy?: {
			positioning: string;
			unique_value_prop: string;
			target_segment: string;
			key_selling_points: string[];
			recommended_channels: Array<{
				name: string;
				priority: "primary" | "secondary";
				rationale: string;
			}>;
			pricing_approach: string;
			bundle_ideas: string[];
			promo_hook: string;
			launch_timing: string;
			content_angle: string;
			content_pillars: string[];
			competitor_diff: string;
			first_30_days: string[];
			risks: string[];
		};
	}>;
	recommendCategory?: string;
	recommendTargetMarket?: string;
	// Web search sources for citation
	searchSources: SearchSource[];
	// Pre-computed metrics per product (indexed by product code)
	computedMetrics: Record<string, ComputedMetrics>;
	// Parsed user goal (from Skill 0)
	parsedGoal?: ParsedGoal;
}

// ---------------------------------------------------------------------------
// Fetch all data needed for strategy generation
// ---------------------------------------------------------------------------

export interface RecommendInput {
	category?: string;
	targetMarket?: string;
	priceRange?: string;
}

function parsePriceRange(priceRange: string): { min: number; max: number } | null {
	// Parse strings like "¥3,000-8,000" or "¥3000〜8000"
	const cleaned = priceRange.replace(/[¥,、]/g, "").replace(/〜/g, "-");
	const match = cleaned.match(/(\d+)\s*[-–]\s*(\d+)/);
	if (!match) return null;
	return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
}

// ---------------------------------------------------------------------------
// New Product Discovery (Rakuten + Brave → Gemini curation)
// ---------------------------------------------------------------------------

export interface DiscoverInput {
	context: "home_shopping" | "live_commerce";
	topCategoryNames: string[];
	explicitCategory?: string;
	targetMarket?: string;
	priceRange?: string;
	userGoal?: string;
	tvProductNames: string[];
	tvMarginRate: number;
	// Exclude items already discovered in prior batches (for re-discover)
	excludeUrls?: string[];
	excludeNames?: string[];
	// Optional free-form analysis summary to guide curation (from prior workflow skills).
	analysisContext?: string;
	// TV shopping success profile built from actual sales data
	tvProfile?: import("@/lib/tv-shopping-profile").TVShoppingProfile;
	// When true, return more products (20) without sales_strategy (lightweight mode)
	lightweight?: boolean;
}

export type DiscoveredProduct = NonNullable<StrategyContext["recommendedProducts"]>[number];

export type SalesStrategy = NonNullable<DiscoveredProduct["sales_strategy"]>;

type DiscoveryPoolItem = {
	name: string;
	price?: number;
	source: "rakuten" | "web";
	source_url: string;
	snippet: string;
	keyword: string;
	reviewCount?: number;
	reviewAverage?: number;
};

export async function discoverNewProducts(
	input: DiscoverInput,
): Promise<StrategyContext["recommendedProducts"]> {
	const lw = !!input.lightweight;
	const RAKUTEN_PER_KW = lw ? 12 : 8;
	const POOL_CAP = lw ? 60 : 40;

	// Build search keywords from TV signals
	const keywords = Array.from(
		new Set(
			[input.explicitCategory, ...input.topCategoryNames]
				.filter((s): s is string => !!s && s.trim().length > 0),
		),
	).slice(0, 4);

	if (keywords.length === 0) return undefined;

	// Normalize keywords for Rakuten — TV category names like "美容・運動" don't match Rakuten well.
	// Split on the middle dot and use the first segment as a cleaner search term.
	const normalizeForRakuten = (kw: string) => kw.split(/[・/／,、]/)[0].trim();

	console.log(`[discover] start context=${input.context} keywords=${JSON.stringify(keywords)} excludeUrls=${input.excludeUrls?.length ?? 0}`);

	// Run Rakuten Item Search (review-count sorted = popularity proxy) + Brave product search
	// + Brave Japan market trend search (separate, used as context not as products)
	const [rakutenResults, braveProductResults, braveTrendResults] = await Promise.all([
		// Rakuten Item Search sorted by review count → real popular products
		// Fall back to Ranking API if Search returns empty
		Promise.all(
			keywords.map(async (kw) => {
				const cleanKw = normalizeForRakuten(kw);
				const attempt = async () => {
					const search = await rakutenItemSearch(cleanKw, "-reviewCount", 10);
					if (search.items.length > 0) return search;
					console.log(`[discover] rakuten search empty for "${cleanKw}", falling back to Ranking API`);
					return await rakutenRankingSearch(cleanKw);
				};
				try {
					return await attempt();
				} catch (err) {
					console.warn(`[discover] rakuten first attempt failed for "${cleanKw}": ${err instanceof Error ? err.message : err}`);
					await new Promise((r) => setTimeout(r, 1000));
					try {
						return await attempt();
					} catch {
						console.warn(`[discover] rakuten retry also failed for "${cleanKw}" — skipping`);
						return { items: [] };
					}
				}
			}),
		),
		// Brave product discovery — Japanese popularity / new product keywords
		Promise.all(
			keywords.map(async (kw) => {
				try {
					return await braveSearchStructured(`${kw} 通販 商品 おすすめ 楽天 Amazon 購入`);
				} catch (err) {
					console.warn(`[discover] brave search failed for "${kw}": ${err instanceof Error ? err.message : err}`);
					await new Promise((r) => setTimeout(r, 1000));
					try {
						return await braveSearchStructured(`${kw} 人気商品 通販 購入ページ`);
					} catch {
						console.warn(`[discover] brave retry also failed for "${kw}" — skipping`);
						return [];
					}
				}
			}),
		),
		// Brave Japan market context — trend signals (NOT products, used as background for Gemini)
		Promise.all([
			braveSearchStructured(
				`${keywords[0] ?? ""} 日本 トレンド 2025 ヒット商品 話題`,
			).catch(() => []),
			braveSearchStructured(
				`日本 通販 売れ筋 ${keywords[0] ?? ""} 消費者 関心`,
			).catch(() => []),
		]),
	]);

	// Build dedup pool, filter out items resembling existing TV products
	// or items already discovered in prior batches.
	const seenUrls = new Set<string>(input.excludeUrls ?? []);
	const tvNames = input.tvProductNames;
	const isTvLike = (name: string) => {
		const lower = name.toLowerCase();
		return tvNames.some((tv) => {
			const head = tv.slice(0, 8).toLowerCase();
			return head.length >= 4 && lower.includes(head);
		});
	};
	const excludeNameHeads = (input.excludeNames ?? [])
		.map((n) => n.slice(0, 10).toLowerCase())
		.filter((h) => h.length >= 4);
	const isAlreadyDiscovered = (name: string) => {
		if (excludeNameHeads.length === 0) return false;
		const lower = name.toLowerCase();
		return excludeNameHeads.some((head) => lower.includes(head));
	};

	const pool: DiscoveryPoolItem[] = [];
	rakutenResults.forEach((r, i) => {
		// Take top 6 per keyword (sorted by review count = social proof)
		for (const item of r.items.slice(0, RAKUTEN_PER_KW)) {
			if (!item.itemUrl || seenUrls.has(item.itemUrl)) continue;
			if (isTvLike(item.itemName)) continue;
			if (isAlreadyDiscovered(item.itemName)) continue;
			seenUrls.add(item.itemUrl);
			pool.push({
				name: item.itemName.slice(0, 80),
				price: item.itemPrice,
				source: "rakuten",
				source_url: item.itemUrl,
				snippet: item.itemCaption.slice(0, 140),
				keyword: keywords[i],
				reviewCount: item.reviewCount,
				reviewAverage: item.reviewAverage,
			});
		}
	});
	braveProductResults.forEach((arr, i) => {
		for (const s of arr.slice(0, 5)) {
			if (!s.url || seenUrls.has(s.url)) continue;
			if (isTvLike(s.title)) continue;
			if (isAlreadyDiscovered(s.title)) continue;
			seenUrls.add(s.url);
			pool.push({
				name: s.title.slice(0, 80),
				source: "web",
				source_url: s.url,
				snippet: s.description.slice(0, 140),
				keyword: keywords[i],
			});
		}
	});

	// Build Japan market context (trend signals — used as background, not products)
	const marketContextLines: string[] = [];
	braveTrendResults.flat().slice(0, 8).forEach((t) => {
		if (!t.title) return;
		marketContextLines.push(`- ${t.title}: ${t.description.slice(0, 120)}`);
	});
	const japanMarketContext = marketContextLines.length > 0
		? marketContextLines.join("\n")
		: "(市場トレンド情報を取得できませんでした)";

	let cappedPool = pool.slice(0, POOL_CAP);
	console.log(`[discover] pool built: total=${pool.length} capped=${cappedPool.length} (rakuten=${pool.filter(p => p.source === 'rakuten').length} web=${pool.filter(p => p.source === 'web').length})`);

	if (cappedPool.length === 0) {
		console.warn(`[discover] pool empty — retrying with broadened keywords`);
		const fallbackKeywords = ["人気商品", "売れ筋", "おすすめ"];
		const fallbackResults = await Promise.all(
			fallbackKeywords.map(async (kw) => {
				const search = await rakutenItemSearch(kw, "-reviewCount", 10).catch(() => ({ items: [] }));
				return search;
			}),
		);
		for (const r of fallbackResults) {
			for (const item of r.items.slice(0, 8)) {
				if (!item.itemUrl || seenUrls.has(item.itemUrl)) continue;
				if (isTvLike(item.itemName)) continue;
				seenUrls.add(item.itemUrl);
				pool.push({
					name: item.itemName.slice(0, 80),
					price: item.itemPrice,
					source: "rakuten",
					source_url: item.itemUrl,
					snippet: item.itemCaption.slice(0, 140),
					keyword: "fallback",
					reviewCount: item.reviewCount,
					reviewAverage: item.reviewAverage,
				});
			}
		}
		cappedPool = pool.slice(0, POOL_CAP);
		console.log(`[discover] fallback pool: ${cappedPool.length} items`);
		if (cappedPool.length === 0) {
			console.warn(`[discover] fallback also empty — returning undefined`);
			return undefined;
		}
	}

	// Curate via Gemini — must pick from REAL pool only
	// Surface review count + average so Gemini can read social proof signals
	const poolText = cappedPool
		.map((p, i) => {
			const reviewBadge = p.reviewCount && p.reviewCount > 0
				? ` ★${p.reviewAverage?.toFixed(1) ?? "?"} (レビュー${p.reviewCount}件)`
				: "";
			return `${i}. [${p.source}] ${p.name}${p.price ? ` (¥${p.price.toLocaleString()})` : ""}${reviewBadge} — keyword: ${p.keyword}\n   URL: ${p.source_url}\n   ${p.snippet}`;
		})
		.join("\n");

	const signalText = [
		`TVトップカテゴリ: ${input.topCategoryNames.join(", ")}`,
		`TV平均粗利率: ${input.tvMarginRate}%`,
		input.explicitCategory ? `指定カテゴリ: ${input.explicitCategory}` : "",
		input.targetMarket ? `ターゲット市場: ${input.targetMarket}` : "",
		input.priceRange ? `想定価格帯: ${input.priceRange}` : "",
		input.userGoal ? `ユーザー目標: ${input.userGoal}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const isLC = input.context === "live_commerce";
	const channelGuidance = isLC
		? `recommended_channels には次から3つ選ぶ: TikTok Live, Instagram Live, YouTube Live, 楽天ROOM LIVE, Yahoo!ショッピング LIVE`
		: `recommended_channels には次から3つ選ぶ: Amazon Japan, 楽天市場, Yahoo!ショッピング, 自社EC (D2C), TV通販 (テレビ東京ダイレクト), TikTok Shop Japan`;
	const contentAngleGuidance = isLC
		? `content_angle: ライブ配信での演出アイデア（実演デモ、ホストのトークポイント、視聴者参加企画等）`
		: `content_angle: 商品ページ/CM/SNS投稿の訴求アングル（ビフォーアフター、専門家推薦、季節企画等）`;
	const roleLabel = isLC ? "ライブコマース事業MD" : "TV通販・EC事業MD";

	const suitabilityBlock = isLC
		? `
=== ライブ配信適合性フィルター ===
以下に該当する商品は選定から除外すること:
- 映像で魅力が伝わりにくい商品 (ソフトウェア、書籍等)
- 配送が困難な大型商品
- 法規制により放送で販売促進が制限される商品

以下の特性を持つ商品を優先すること:
- ホストが手に取って実演できる
- リアルタイムのコメント・質問に応えやすい
- 限定感・タイムセール感を演出できる
- SNSでシェアされやすいビジュアル
`
		: `
=== TV通販適合性フィルター ===
以下に該当する商品は選定から除外すること:
- 専門的な設置工事が必要な商品 (業務用機器、大型据付家電等)
- 画面上でデモンストレーションが困難な商品 (ソフトウェア、デジタルサービス等)
- 法規制により放送で販売促進が制限される商品 (医薬品、金融商品等)
- 消耗品のみで単価が低すぎる商品 (¥500未満の日用品)
- 専門資格がないと使用できない商品

以下の特性を持つ商品を優先すること:
- 映像でのビフォーアフターが見せやすい (美容、掃除、料理等)
- 実演デモで効果を即座に伝えられる
- 視聴者が衝動買いしやすい価格帯 (¥3,000〜¥30,000)
- ギフト需要があり、季節性を活かせる
- 既存TV通販カテゴリの隣接領域で新鮮味がある
`;

	const analysisBlock = input.analysisContext && input.analysisContext.trim().length > 0
		? `\n=== (0) 事前分析結果 (Goal分析・チャネル戦略・価格戦略・マーケ・リスク等のサマリー) ===\nこの戦略フレームワークに沿って新商品を選定すること。\n${input.analysisContext}\n`
		: "";

	// TV shopping success profile from actual sales data
	const profileBlock = input.tvProfile
		? `\n${formatProfileForPrompt(input.tvProfile)}\n`
		: "";

	const itemCount = lw ? 20 : 8;
	const taskDescription = lw
		? `新商品を${itemCount}個選定してください。`
		: `新商品を${itemCount}つ選定し、各商品の販売戦略まで策定してください。`;

	const salesStrategySchema = lw ? "" : `,
  "sales_strategy": {
    "positioning":"市場でのポジショニング (1文)",
    "unique_value_prop":"競合と比較した一文の独自価値提案",
    "target_segment":"具体的なターゲット層 (年齢/性別/ライフスタイル/年収帯)",
    "key_selling_points":["訴求ポイント1","訴求ポイント2","訴求ポイント3","訴求ポイント4"],
    "recommended_channels":[
      {"name":"チャネル名","priority":"primary","rationale":"なぜ最優先か"},
      {"name":"チャネル名","priority":"secondary","rationale":"補助的役割"}
    ],
    "pricing_approach":"価格戦略 (バンドル/単品/サブスク/初回限定価格等の具体案)",
    "bundle_ideas":["セット案1","セット案2"],
    "promo_hook":"初動で使うプロモフック (キャッチコピー風)",
    "launch_timing":"投入時期と理由 (季節/イベント/競合空白期)",
    "content_angle":"コンテンツ訴求の切り口",
    "content_pillars":["コンテンツの柱1","柱2","柱3"],
    "competitor_diff":"主要競合と比べた差別化ポイント",
    "first_30_days":["30日以内のアクション1","2","3","4"],
    "risks":["懸念リスク1","リスク2"]
  }`;

	const salesStrategyRules = lw ? "" : `
- 各商品ごとに sales_strategy を必ず記入する。
- ${channelGuidance}
- ${contentAngleGuidance}`;

	const salesStrategyFooter = lw ? "" : "\nAll text in Japanese. すべての sales_strategy フィールドを必ず埋めること。";

	const prompt = `あなたは日本の${roleLabel}です。下記の (1) TV自社販売シグナル と (2) 日本市場トレンド情報 の両方を根拠に、楽天/Webから検索された実在商品プールから「日本の消費者に今売れる/関心が高い」${taskDescription}
${analysisBlock}${profileBlock}
=== (1) TV自社販売シグナル ===
${signalText}

=== (2) 日本市場トレンド情報 (Brave Web Search より) ===
${japanMarketContext}

=== (3) 検索された実在商品プール (${cappedPool.length}件) ===
※ レビュー数/評価は楽天での実際の社会的証明 (popularity proxy) です
${poolText}

=== 厳守ルール ===
- 必ず上記プールに存在する商品のみから選ぶこと。プールにない商品名を作らないこと。
- source_url は商品の個別ページURL (楽天商品ページ、Amazon商品ページ、メーカー公式ページ等)。プールに商品個別URLがある場合はそのままコピー。ランキングページや一覧ページのURLしかない場合は、商品名から推測される楽天/Amazon/公式の商品個別ページURLを記載すること。
- ranking_info はランキング順位情報 (例: "楽天デイリーランキング1位"、"価格.com人気売れ筋3位" 等)。ランキング情報がない場合は省略。
- name は商品プールの name フィールドをそのまま使用。
- カテゴリが偏らないように${itemCount}商品を選定。
- 各商品ごとに japan_market_fit を必ず記入する。${salesStrategyRules}
${suitabilityBlock}

=== japan_fit_score 採点ルール (0-100) ===
以下の加点で算出すること。各カテゴリで該当する一段階のみ加点 (重複加点禁止):
- 楽天レビュー数: ≥100件→+20 / 50-99件→+12 / 5-49件→+5 / それ以下→0
- 楽天レビュー平均: ≥4.0→+15 / 3.5-3.9→+8 / それ未満→0
- TVトップカテゴリ一致: 一致→+20 / 隣接→+10 / 不一致→0
- 日本市場トレンド情報に関連語句あり: あり→+15 / なし→0
- ユーザー目標/ターゲット市場合致: 合致→+10 / 不合致→0
- TV通販/ライブ配信実演適合性 (映像デモ可能・衝動買い価格帯・ギフト需要): 高→+20 / 中→+10 / 低→0
- 合計は必ず 0-100 の範囲に収めること (上限超えは100に丸める)

=== japan_market_fit の記入指針 ===
- popularity_evidence: 楽天レビュー数/評価、Web 検索結果から読み取れる人気度の具体的根拠 (数値ベースで記述)
- trend_context: 上記「日本市場トレンド情報」のうち、この商品に関連するトレンドを引用
- why_japan_now: なぜ今この商品が日本で売れるか (季節性/世代/世相/競合空白)
- review_signal: 楽天レビュー数と評価がある場合、そのまま「★X.X (Y件)」形式で記述

Return a JSON array of exactly ${itemCount} items (no markdown):
[{
  "name":"<プールから>",
  "reason":"なぜTVシグナル + 日本市場トレンドに合致するか",
  "japan_fit_score":0-100,
  "estimated_demand":"高|中|低",
  "supply_source":"楽天 or Webドメイン",
  "estimated_price_jpy":"¥X-Y",
  "source":"rakuten|web",
  "source_url":"<商品個別ページURL (楽天/Amazon/公式等)>",
  "ranking_info":"楽天ランキングX位 / 価格.comX位 等 (なければ省略)",
  "signal_basis":"TV自社シグナルとの紐付け",
  "japan_market_fit": {
    "popularity_evidence":"楽天レビュー数/評価やWeb検索から読み取れる人気の具体的根拠",
    "trend_context":"日本市場トレンド情報からの引用 (情報なしの場合は「取得不可」と記載)",
    "why_japan_now":"なぜ今この商品が日本で売れるか",
    "review_signal":"★X.X (Y件) — レビュー情報がない場合はこのフィールド自体を省略すること (空文字や null 文字列にしない)"
  }${salesStrategySchema}
}]
${salesStrategyFooter}`;

	try {
		console.log(`[discover] calling Gemini for curation (prompt length=${prompt.length})`);
		const raw = await callGemini(prompt);
		console.log(`[discover] Gemini raw response length=${raw.length}, head="${raw.slice(0, 120).replace(/\n/g, ' ')}"`);
		// Use the robust parseJSON helper — handles markdown fences, arrays, nested braces.
		const parsed = parseJSON<NonNullable<StrategyContext["recommendedProducts"]>>(raw);
		if (!Array.isArray(parsed)) {
			console.warn(`[discover] Gemini response is not an array (got ${typeof parsed})`);
			return undefined;
		}
		console.log(`[discover] parsed ${parsed.length} items from Gemini`);

		// Sanity-pass: verify items came from the actual pool (anti-hallucination).
		// Check by name prefix match since Gemini may generate individual product URLs
		// instead of copying pool URLs directly.
		const poolNames = cappedPool.map((p) => p.name.slice(0, 15).toLowerCase());
		const filtered = parsed.filter((p) => {
			if (!p.name || !p.source_url) return false;
			const nameHead = p.name.slice(0, 15).toLowerCase();
			return poolNames.some((pn) => nameHead.includes(pn) || pn.includes(nameHead));
		});
		console.log(`[discover] sanity-pass: ${filtered.length}/${parsed.length} items survived name-match check`);
		if (filtered.length === 0 && parsed.length > 0) {
			console.warn(`[discover] all ${parsed.length} Gemini items failed sanity-pass — Gemini may have hallucinated products`);
		}
		return filtered.length > 0 ? filtered : undefined;
	} catch (err) {
		console.error("[md-strategy] discovery curation failed:", err);
		return undefined;
	}
}

export async function fetchStrategyContext(
	userGoal?: string,
	recommend?: RecommendInput,
): Promise<StrategyContext> {
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

	let sortedProducts = Object.values(productMap)
		.map((p) => ({ ...p, marginRate: p.totalRevenue > 0 ? Math.round((p.totalProfit / p.totalRevenue) * 10000) / 100 : 0, avgWeeklyQty: p.weekCount > 0 ? Math.round(p.totalQuantity / p.weekCount) : 0 }))
		.sort((a, b) => b.totalRevenue - a.totalRevenue);

	// --- Category filtering when recommend.category is provided ---
	if (recommend?.category) {
		const salesCategories = CATEGORY_MAPPING[recommend.category] ?? [];
		if (salesCategories.length > 0) {
			const matched = sortedProducts.filter((p) => p.category && salesCategories.includes(p.category));
			const unmatched = sortedProducts.filter((p) => !p.category || !salesCategories.includes(p.category));
			if (matched.length >= 5) {
				sortedProducts = matched;
			} else {
				// Include unmatched to fill up, but matched ones come first
				sortedProducts = [...matched, ...unmatched];
			}
		}
	}

	// --- Price range filtering by TV unit price ---
	if (recommend?.priceRange) {
		const range = parsePriceRange(recommend.priceRange);
		if (range) {
			const priceFiltered = sortedProducts.filter((p) => {
				const unitPrice = p.totalQuantity > 0 ? Math.round(p.totalRevenue / p.totalQuantity) : 0;
				return unitPrice >= range.min && unitPrice <= range.max;
			});
			// Only apply filter if it leaves enough products
			if (priceFiltered.length >= 5) {
				sortedProducts = priceFiltered;
			}
		}
	}

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

	let categoryBreakdown = Object.entries(catMap)
		.map(([category, d]) => ({
			category,
			...d,
			marginRate: d.revenue > 0 ? Math.round((d.profit / d.revenue) * 10000) / 100 : 0,
		}))
		.sort((a, b) => b.revenue - a.revenue);

	// Filter categoryBreakdown to prioritize matching categories
	if (recommend?.category) {
		const salesCategories = CATEGORY_MAPPING[recommend.category] ?? [];
		if (salesCategories.length > 0) {
			const matchedCats = categoryBreakdown.filter((c) => salesCategories.includes(c.category));
			const unmatchedCats = categoryBreakdown.filter((c) => !salesCategories.includes(c.category));
			categoryBreakdown = [...matchedCats, ...unmatchedCats];
		}
	}

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

	// Compute metrics for each enriched product
	const computedMetricsMap: Record<string, ComputedMetrics> = {};
	for (const p of enrichedProducts) {
		computedMetricsMap[p.code] = computeMetrics(p);
	}

	// Weekly trends
	const weeklyTrends = ((weeklyTotalResult.data ?? []) as SalesWeeklyTotal[])
		.map((w) => ({ weekStart: w.week_start, revenue: w.total_revenue, profit: w.total_gross_profit, quantity: w.total_quantity }))
		.reverse();

	// Brave Search for market intelligence (runs in parallel)
	const searchQueries = [
		recommend?.category ? `${recommend.category} EC 市場 日本 2026 トレンド` : "EC 拡大戦略 日本 2026",
		recommend?.category ? `${recommend.category} Amazon 楽天 チャネル展開 成功事例` : "TV通販 EC展開 成功事例 日本",
		"EC 越境 SNSコマース TikTok Shop 日本 市場規模",
	];
	const searchResults = await Promise.all(searchQueries.map((q) => braveSearchStructured(q)));
	const searchSources = searchResults.flat();

	// New Product Discovery — uses TV signals (top categories, userGoal, optional explicit category)
	// to drive REAL Rakuten + Brave searches, then Gemini curates 5 from the actual pool.
	const recommendCategory = recommend?.category;
	const recommendTargetMarket = recommend?.targetMarket;
	// Discovery is deferred to a FINAL workflow step so it can use all prior skill
	// outputs as analysisContext. fetchStrategyContext no longer kicks it off.

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
		recommendCategory,
		recommendTargetMarket,
		searchSources,
		computedMetrics: computedMetricsMap,
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
	sources_cited?: Array<{ index: number; title: string; url: string }>;
	// Newly discovered products from real Rakuten/Web searches (injected by orchestrator)
	discovered_new_products?: DiscoveredProduct[];
	// History of all discovery batches (initial + re-discovers). Latest first.
	discovery_history?: DiscoveryBatch[];
}

// ---------------------------------------------------------------------------
// Per-product analysis — generates SalesStrategy for a single discovered product
// ---------------------------------------------------------------------------

export async function analyzeDiscoveredProduct(
	product: DiscoveredProduct,
	profile: import("@/lib/tv-shopping-profile").TVShoppingProfile,
	context: "home_shopping" | "live_commerce",
): Promise<SalesStrategy> {
	const isLC = context === "live_commerce";
	const roleLabel = isLC ? "ライブコマース事業MD" : "TV通販・EC事業MD";
	const channelGuidance = isLC
		? `recommended_channels には次から3つ選ぶ: TikTok Live, Instagram Live, YouTube Live, 楽天ROOM LIVE, Yahoo!ショッピング LIVE`
		: `recommended_channels には次から3つ選ぶ: Amazon Japan, 楽天市場, Yahoo!ショッピング, 自社EC (D2C), TV通販 (テレビ東京ダイレクト), TikTok Shop Japan`;
	const contentAngleGuidance = isLC
		? `content_angle: ライブ配信での演出アイデア（実演デモ、ホストのトークポイント、視聴者参加企画等）`
		: `content_angle: 商品ページ/CM/SNS投稿の訴求アングル（ビフォーアフター、専門家推薦、季節企画等）`;

	const profileSection = formatProfileForPrompt(profile);

	const prompt = `あなたは日本の${roleLabel}です。以下の商品について詳細な販売戦略を策定してください。

=== 対象商品 ===
商品名: ${product.name}
推定価格: ${product.estimated_price_jpy}
ソース: ${product.source} (${product.source_url})
推定需要: ${product.estimated_demand}
TV適合スコア: ${product.japan_fit_score}/100
選定理由: ${product.reason}
シグナル根拠: ${product.signal_basis}
${product.japan_market_fit ? `人気根拠: ${product.japan_market_fit.popularity_evidence}
トレンド: ${product.japan_market_fit.trend_context}
なぜ今日本で: ${product.japan_market_fit.why_japan_now}` : ""}

${profileSection}

=== ルール ===
- ${channelGuidance}
- ${contentAngleGuidance}
- すべてのフィールドを具体的に埋めること

Return a single JSON object (no markdown, no array):
{
  "positioning":"市場でのポジショニング (1文)",
  "unique_value_prop":"競合と比較した一文の独自価値提案",
  "target_segment":"具体的なターゲット層 (年齢/性別/ライフスタイル/年収帯)",
  "key_selling_points":["訴求ポイント1","訴求ポイント2","訴求ポイント3","訴求ポイント4"],
  "recommended_channels":[
    {"name":"チャネル名","priority":"primary","rationale":"なぜ最優先か"},
    {"name":"チャネル名","priority":"secondary","rationale":"補助的役割"}
  ],
  "pricing_approach":"価格戦略の具体案",
  "bundle_ideas":["セット案1","セット案2"],
  "promo_hook":"初動で使うプロモフック (キャッチコピー風)",
  "launch_timing":"投入時期と理由",
  "content_angle":"コンテンツ訴求の切り口",
  "content_pillars":["コンテンツの柱1","柱2","柱3"],
  "competitor_diff":"主要競合と比べた差別化ポイント",
  "first_30_days":["30日以内のアクション1","2","3","4"],
  "risks":["懸念リスク1","リスク2"]
}

All text in Japanese.`;

	const raw = await callGemini(prompt);
	const parsed = parseJSON<SalesStrategy>(raw);
	return parsed;
}

export interface DiscoveryBatch {
	generatedAt: string;
	focus?: string;
	products: DiscoveredProduct[];
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
	sources_cited?: Array<{ index: number; title: string; url: string }>;
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
	sources_cited?: Array<{ index: number; title: string; url: string }>;
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
	sources_cited?: Array<{ index: number; title: string; url: string }>;
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
	sources_cited?: Array<{ index: number; title: string; url: string }>;
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
	sources_cited?: Array<{ index: number; title: string; url: string }>;
}

export interface FullStrategyResult {
	goal_analysis?: ParsedGoal | null;
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
	| "goal_analysis"
	| "product_selection"
	| "channel_strategy"
	| "pricing_margin"
	| "marketing_execution"
	| "financial_projection"
	| "risk_contingency";

export const SKILL_META: Record<SkillName, { label: string; labelJa: string }> = {
	goal_analysis: { label: "Goal Analysis", labelJa: "目標分析" },
	product_selection: { label: "Product Selection", labelJa: "商品選定" },
	channel_strategy: { label: "Channel Strategy", labelJa: "チャネル戦略" },
	pricing_margin: { label: "Pricing & Margin", labelJa: "価格・マージン戦略" },
	marketing_execution: { label: "Marketing Execution", labelJa: "マーケティング実行計画" },
	financial_projection: { label: "Financial Projection", labelJa: "収益予測" },
	risk_contingency: { label: "Risk & Contingency", labelJa: "リスク・対策" },
};

export interface ProgressEvent {
	skill: SkillName | "data_fetch" | "new_product_discovery";
	status: "running" | "complete" | "error";
	index: number;
	total: number;
	data?: unknown;
	error?: string;
}

// ---------------------------------------------------------------------------
// Helper: format helpers for prompts
// ---------------------------------------------------------------------------

function formatYen(n: number): string {
	return `¥${n.toLocaleString()}`;
}

function buildGoalSection(parsedGoal?: ParsedGoal): string {
	if (!parsedGoal) return "";
	const lines = [
		`\n=== 目標分析結果（Skill 0） ===`,
		`- 主要目的: ${parsedGoal.primary_objective}`,
		`- 対象チャネル: ${parsedGoal.target_channels.join(", ")}`,
	];
	if (parsedGoal.target_revenue) lines.push(`- 目標売上: ${parsedGoal.target_revenue}`);
	if (parsedGoal.target_audience) lines.push(`- ターゲット層: ${parsedGoal.target_audience}`);
	if (parsedGoal.budget_constraint) lines.push(`- 予算制約: ${parsedGoal.budget_constraint}`);
	if (parsedGoal.timeline) lines.push(`- タイムライン: ${parsedGoal.timeline}`);
	lines.push(`\n上記の目標を全ての分析で最優先に考慮してください。\n`);
	return lines.join("\n");
}

function buildSourcesSection(ctx: StrategyContext): string {
	if (ctx.searchSources.length === 0) return "";
	const lines = ctx.searchSources
		.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`)
		.join("\n");
	const searchData = ctx.searchSources
		.slice(0, 15)
		.map((s) => `- ${s.title}: ${s.description}`)
		.join("\n");
	return `
[SOURCES — 出典]
=== 参考市場データ（Web検索）===
${searchData}

=== 出典リスト ===
${lines}

分析の根拠となる外部情報には、可能な限り出典を[1][2]のように番号で引用してください。
引用した出典は "sources_cited" フィールドに [{index: 番号, title: "タイトル", url: "URL"}] として含めてください。`;
}

function buildChannelReferenceTable(): string {
	const header = `| チャネル | 手数料 | 月額費用 | フルフィルメント | 初期費用 | セットアップ期間 |`;
	const sep = `|---|---|---|---|---|---|`;
	const rows = CHANNEL_REFERENCE.map((ch) =>
		`| ${ch.name} | ${ch.commission} | ${ch.monthlyFee} | ${ch.fulfillment} | ${ch.initialCost} | ${ch.setupTime} |`
	).join("\n");
	return `${header}\n${sep}\n${rows}`;
}

// ---------------------------------------------------------------------------
// Skill 0: Goal Analysis
// ---------------------------------------------------------------------------

async function runGoalAnalysis(userGoal: string): Promise<ParsedGoal> {
	const prompt = `You are a business strategy analyst. Parse the following user goal into structured components.

User Goal: ${userGoal}

Return a JSON object (no markdown) with this structure:
{
  "primary_objective": "主要な目的を1文で",
  "target_channels": ["対象チャネル名のリスト"],
  "target_revenue": "目標売上（言及されている場合）",
  "target_audience": "ターゲット層（言及されている場合）",
  "budget_constraint": "予算制約（言及されている場合）",
  "timeline": "タイムライン（言及されている場合）"
}

IMPORTANT: すべてのテキストフィールドは日本語で記述してください。言及されていないフィールドはnullにしてください。`;

	const raw = await callGemini(prompt);
	return parseJSON<ParsedGoal>(raw);
}

// ---------------------------------------------------------------------------
// Prompt Builders (rewritten with DATA-first, TASK-last structure)
// ---------------------------------------------------------------------------

function buildProductSelectionPrompt(ctx: StrategyContext): string {
	// Build Markdown table for products with pre-computed metrics
	const tableHeader = `| # | 商品名 | カテゴリ | 年売上 | 粗利率 | 週平均 | 3M成長率 | TV単価 | 原価 | EC15%後マージン | EC既存 | 季節ピーク |`;
	const tableSep = `|---|---|---|---|---|---|---|---|---|---|---|---|`;
	const tableRows = ctx.products.slice(0, 30).map((p, i) => {
		const m = ctx.computedMetrics[p.code];
		return `| ${i + 1} | ${p.name} | ${p.category ?? "分類なし"} | ${formatYen(p.totalRevenue)} | ${p.marginRate}% | ${p.avgWeeklyQty}個 | ${m.monthlyGrowthRate > 0 ? "+" : ""}${m.monthlyGrowthRate}% | ${formatYen(m.tvUnitPrice)} | ${p.costPrice != null ? formatYen(p.costPrice) : "不明"} | ${m.ecMarginAfterFees}% | ${m.hasEcPresence ? "○" : "×"} | ${m.seasonalPeak} |`;
	}).join("\n");

	// Newly discovered products (REAL items found via Rakuten/Web search)
	let recommendSection = "";
	if (ctx.recommendedProducts && ctx.recommendedProducts.length > 0) {
		const recLines = ctx.recommendedProducts
			.map(
				(p, i) =>
					`${i + 1}. [${p.source}] ${p.name} — 適合度${p.japan_fit_score}/100, 需要: ${p.estimated_demand}, 想定価格: ${p.estimated_price_jpy}\n   出典: ${p.source_url}\n   シグナル根拠: ${p.signal_basis}\n   理由: ${p.reason}`,
			)
			.join("\n");
		recommendSection = `\n=== 楽天/Web から発掘された新規実在商品 (TVシグナル基準) ===
${recLines}

これらは実在する商品です。チャネル割当時は code を "NEW-1", "NEW-2" のように振り、name は上記のままコピーしてください。\n`;
	}

	return `[ROLE] あなたはTV通販チャネルのMD（マーチャンダイザー）です。EC・SNS・D2C・越境ECへの商品展開を計画しています。
${buildGoalSection(ctx.parsedGoal)}
[DATA — 構造化データ]

=== TV通販（テレビ東京ダイレクト）全体実績 ===
- 総売上: ${formatYen(ctx.annualMetrics.totalRevenue)}
- 総粗利: ${formatYen(ctx.annualMetrics.totalProfit)}
- 粗利率: ${ctx.annualMetrics.marginRate}%
- 集計期間: ${ctx.annualMetrics.weekCount}週間 (2025-2026年)
- 取扱商品数: ${ctx.annualMetrics.productCount}

=== カテゴリ別実績 ===
${ctx.categoryBreakdown.slice(0, 12).map((c) => `- ${c.category}: 売上${formatYen(c.revenue)} / 粗利率${c.marginRate}% / ${c.quantity.toLocaleString()}個 / ${c.productCount}商品`).join("\n")}

=== 商品実績データ（上位30商品） ===
${tableHeader}
${tableSep}
${tableRows}

=== チャネル基本情報 ===
${buildChannelReferenceTable()}
${recommendSection}
[FRAMEWORK — 分析基準]

商品選定の判定基準:
- tier1 (即投入): 粗利率 ≥ 30% AND EC15%後マージン ≥ 15% AND (trajectory=growing OR 週平均 ≥ 10個)
- tier2 (第2弾): 粗利率 ≥ 25% AND EC15%後マージン ≥ 10%
- exclusion (除外): EC15%後マージン < 5% OR trajectory=declining AND 粗利率 < 20%
- EC既存商品(○)は優先的にtier1に含める（販売実績があるため）
- 季節性を考慮: ピーク月の2ヶ月前にtier1投入を推奨
- カテゴリバランス: 1チャネルに同カテゴリ3品以上を避ける
- 推薦商品(NEW-*)は既存実績商品と組み合わせてポートフォリオに含める

[TASK — 分析指示]

各チャネルに投入すべき商品を選定してください。
- tier1_products: 各チャネル3-5品。必ず上記テーブルの数値を引用して根拠を示すこと。
- tier2_products: 各チャネル2-3品。
- exclusions: そのチャネルに不適合な商品とその理由。
- monthly_trajectory: 3M成長率から growing/stable/declining を判定。
- margin_headroom: 「原価¥X、EC手数料Y%でも粗利Z%確保可能」のように計算結果を記載。
- portfolio_strategy: 全体のポートフォリオ戦略。

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
  "portfolio_strategy": "全体戦略",
  "sources_cited": [{"index": 1, "title": "出典タイトル", "url": "https://..."}]
}
${buildSourcesSection(ctx)}`;
}

const EMPTY_PS: ProductSelectionOutput = { channel_product_matrix: [], portfolio_strategy: "" };
const EMPTY_CS: ChannelStrategyOutput = { channels: [], launch_sequence: [] };
const EMPTY_PM: PricingMarginOutput = { product_pricing: [], bep_analysis: [], margin_optimization: [] };
const EMPTY_ME: MarketingExecutionOutput = { monthly_plans: [], content_calendar: [], influencer_plan: [], budget_summary: { total_6month: 0, by_channel: {}, by_type: {} } };
const EMPTY_FP: FinancialProjectionOutput = { monthly_forecast: [], roi_timeline: [], scenarios: { conservative: { year1_revenue: 0, year1_profit: 0 }, moderate: { year1_revenue: 0, year1_profit: 0 }, aggressive: { year1_revenue: 0, year1_profit: 0 }, assumptions: [] } };

function buildChannelStrategyPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const ps = (priorOutputs.product_selection as ProductSelectionOutput) ?? EMPTY_PS;

	// Build structured tier1 summary with margin and revenue data
	const tier1ByChannel = (ps?.channel_product_matrix ?? []).map((ch) => {
		const productDetails = ch.tier1_products.map((tp) => {
			const p = ctx.products.find((pr) => pr.code === tp.code);
			const m = p ? ctx.computedMetrics[p.code] : null;
			return `    - ${tp.name} [${tp.code}]: margin_headroom=${tp.margin_headroom}, trajectory=${tp.monthly_trajectory}${p ? `, 年売上${formatYen(p.totalRevenue)}` : ""}${m ? `, EC後マージン${m.ecMarginAfterFees}%` : ""}`;
		}).join("\n");
		return `  ${ch.channel}:\n${productDetails}`;
	}).join("\n");

	// Aggregate distribution channel fit_scores from research
	const channelFitAgg: Record<string, { totalScore: number; count: number }> = {};
	for (const p of ctx.products) {
		if (!p.research?.distributionChannels) continue;
		for (const dc of p.research.distributionChannels) {
			if (!channelFitAgg[dc.channel_name]) channelFitAgg[dc.channel_name] = { totalScore: 0, count: 0 };
			channelFitAgg[dc.channel_name].totalScore += dc.fit_score;
			channelFitAgg[dc.channel_name].count += 1;
		}
	}
	const fitScoreLines = Object.entries(channelFitAgg)
		.map(([ch, d]) => `- ${ch}: 平均適合度 ${Math.round(d.totalScore / d.count)}/100 (${d.count}商品から)`)
		.join("\n");

	return `[ROLE] あなたはEC・SNSコマース専門の戦略コンサルタントです。TV通販MDが各チャネルへ展開する際の詳細な進出戦略を策定してください。
${buildGoalSection(ctx.parsedGoal)}
[DATA — 構造化データ]

=== TV通販全体実績 ===
- 総売上: ${formatYen(ctx.annualMetrics.totalRevenue)}
- 粗利率: ${ctx.annualMetrics.marginRate}%
- 取扱商品数: ${ctx.annualMetrics.productCount}

=== チャネル基本情報（事実データ — 調査不要） ===
${buildChannelReferenceTable()}

=== 商品選定結果（Skill 1） ===
${tier1ByChannel}
ポートフォリオ戦略: ${ps.portfolio_strategy}

=== AI分析による各チャネル適合度（全商品集計） ===
${fitScoreLines || "（チャネル適合度データなし）"}

[PRIOR — 前ステップ分析結果]
- Skill 1（商品選定）: ${ps.channel_product_matrix.length}チャネルに商品を配分済み
- tier1商品合計: ${ps.channel_product_matrix.reduce((s, ch) => s + ch.tier1_products.length, 0)}品

[FRAMEWORK — 分析基準]

チャネル優先度の判定:
- immediate: 初期費用 ≤ ¥30万 AND 既にEC実績あり AND tier1商品3品以上
- 3month: 初期費用 ≤ ¥50万 AND セットアップ1ヶ月以内
- 6month: 初期費用 ≤ ¥100万 OR 特殊な準備が必要
- 12month: 越境EC等、大規模投資・現地拠点が必要

KPI目標設定基準:
- 月間売上目標 = TV通販の同商品売上 × EC転換率（初月5%, 3ヶ月後15%, 6ヶ月後25%）
- CVR目標: Amazon 3-5%, 楽天 2-4%, Yahoo 2-3%, SNS 1-2%

[TASK — 分析指示]

7チャネルそれぞれについて詳細な進出戦略を策定してください。
上記のチャネル基本情報テーブルの数値を活用し、具体的な費用・期間を記載すること。

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
  "launch_sequence": [{"phase": "", "channels": [], "timeline": "", "rationale": ""}],
  "sources_cited": [{"index": 1, "title": "", "url": ""}]
}
${buildSourcesSection(ctx)}`;
}

function buildPricingMarginPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const ps = (priorOutputs.product_selection as ProductSelectionOutput) ?? EMPTY_PS;
	const cs = (priorOutputs.channel_strategy as ChannelStrategyOutput) ?? EMPTY_CS;

	// Collect tier1 product codes across all channels
	const tier1Codes = new Set<string>();
	for (const ch of ps.channel_product_matrix) {
		for (const p of ch.tier1_products) tier1Codes.add(p.code);
	}

	const tier1Products = ctx.products.filter((p) => tier1Codes.has(p.code));

	// Build pre-computed BEP table for each tier1 product x channel
	const bepTableHeader = `| 商品名 | チャネル | TV単価 | 原価 | 手数料率 | 手数料額 | 粗利/個 | BEP(個/月) |`;
	const bepTableSep = `|---|---|---|---|---|---|---|---|`;
	const bepRows: string[] = [];

	for (const p of tier1Products) {
		const m = ctx.computedMetrics[p.code];
		const costPrice = p.costPrice ?? Math.round(m.tvUnitPrice * (1 - (p.marginRate / 100)));

		for (const ch of CHANNEL_REFERENCE) {
			// Parse min commission rate
			const commMatch = ch.commission.match(/(\d+(?:\.\d+)?)/);
			const commRate = commMatch ? parseFloat(commMatch[1]) / 100 : 0.10;
			const commAmount = Math.round(m.tvUnitPrice * commRate);
			const grossMarginPerUnit = m.tvUnitPrice - costPrice - commAmount;

			// Estimate fixed costs from channel reference (use midpoint of range)
			const fixedNums = [...ch.initialCost.matchAll(/(\d+)/g)].map((m) => parseInt(m[1], 10));
			const fixedMidpoint = fixedNums.length >= 2 ? (fixedNums[0] + fixedNums[1]) / 2 : fixedNums[0] ?? 5;
			const monthlyFixedEstimate = fixedMidpoint * 10000 / 6; // Amortize over 6 months
			const monthlyFeeMatch = ch.monthlyFee.match(/(\d[\d,]*)/);
			const monthlyFee = monthlyFeeMatch ? parseInt(monthlyFeeMatch[1].replace(/,/g, ""), 10) : 0;
			const totalMonthlyFixed = Math.round(monthlyFixedEstimate + monthlyFee);

			const bepUnits = grossMarginPerUnit > 0 ? Math.ceil(totalMonthlyFixed / grossMarginPerUnit) : 9999;

			bepRows.push(`| ${p.name.slice(0, 15)} | ${ch.name} | ${formatYen(m.tvUnitPrice)} | ${formatYen(costPrice)} | ${(commRate * 100).toFixed(1)}% | ${formatYen(commAmount)} | ${formatYen(grossMarginPerUnit)} | ${bepUnits} |`);
		}
	}

	// Product pricing data table
	const pricingTableHeader = `| 商品名 | コード | TV単価 | 原価 | 卸売率 | 粗利率 | SKU価格帯 | 競合価格 |`;
	const pricingTableSep = `|---|---|---|---|---|---|---|---|`;
	const pricingRows = tier1Products.map((p) => {
		const m = ctx.computedMetrics[p.code];
		const compPrices = p.research?.competitors?.slice(0, 2).map((c) => `${c.name}=${c.price}`).join(", ") || "-";
		return `| ${p.name.slice(0, 20)} | ${p.code} | ${formatYen(m.tvUnitPrice)} | ${p.costPrice != null ? formatYen(p.costPrice) : "不明"} | ${p.wholesaleRate ?? "不明"}% | ${p.marginRate}% | ${m.priceRange} | ${compPrices} |`;
	}).join("\n");

	// Channel fee summary from Skill 2
	const channelFeeLines = cs.channels
		.map((ch) => `- ${ch.name}: 手数料${ch.fee_structure.commission_rate}, 月額${ch.fee_structure.monthly_fee}, フルフィルメント: ${ch.fee_structure.fulfillment_options.join("/")}`)
		.join("\n");

	return `[ROLE] あなたはEC事業の価格戦略スペシャリストです。TV通販商品のEC展開における最適価格とマージン構造を設計してください。
${buildGoalSection(ctx.parsedGoal)}
[DATA — 構造化データ]

=== 対象商品の原価・価格データ ===
${pricingTableHeader}
${pricingTableSep}
${pricingRows}

=== チャネル手数料構造（Skill 2確定値） ===
${channelFeeLines}

=== サーバー事前計算: BEP分析テーブル ===
以下はサーバーサイドで計算済みの損益分岐点です。この数値を検証し、戦略的な推奨価格を提案してください。
（固定費は初期費用の6ヶ月按分 + 月額費用で概算）

${bepTableHeader}
${bepTableSep}
${bepRows.join("\n")}

[PRIOR — 前ステップ分析結果]
- Skill 1（商品選定）: tier1商品 ${tier1Products.length}品を対象
- Skill 2（チャネル戦略）: ${cs.channels.length}チャネルの手数料構造確定

[FRAMEWORK — 分析基準]

価格設定の判定基準:
- EC販売価格 = TV単価の90-110%（TV視聴者との価格矛盾を避ける）
- 最低マージン: 手数料控除後 ≥ 15%（これ未満は撤退検討）
- 競合ベンチマーク: 競合価格の±10%以内を推奨
- BEP達成目標: 3ヶ月以内 = 優良、6ヶ月以内 = 許容、6ヶ月超 = 要再検討

BEP検証ルール:
- 上記テーブルの計算値を確認し、非現実的な場合は修正理由を明記
- 広告費(月額¥50,000-200,000)を固定費に追加した場合のBEPも考慮

[TASK — 分析指示]

1. 各商品×各チャネルの最適EC販売価格を設計
2. 上記BEPテーブルの検証と、広告費込みの実践的BEP算出
3. マージン最適化の具体的提案

計算結果をそのまま使うのではなく、競合価格・市場感覚を加味して戦略的な推奨価格を提案すること。

IMPORTANT: すべてのテキストフィールドは日本語で記述。

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
  "margin_optimization": ["具体的な改善提案"],
  "sources_cited": [{"index": 1, "title": "", "url": ""}]
}
${buildSourcesSection(ctx)}`;
}

function buildMarketingExecutionPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const ps = (priorOutputs.product_selection as ProductSelectionOutput) ?? EMPTY_PS;
	const cs = (priorOutputs.channel_strategy as ChannelStrategyOutput) ?? EMPTY_CS;
	const pm = (priorOutputs.pricing_margin as PricingMarginOutput) ?? EMPTY_PM;

	// Aggregate demographics across ALL products (not just 5)
	const demoAgg: Record<string, number> = {};
	const genderAgg: Record<string, number> = {};
	const interestAgg: Record<string, number> = {};
	let demoCount = 0;
	for (const p of ctx.products) {
		if (!p.research?.demographics) continue;
		demoCount++;
		const d = p.research.demographics;
		if (d.age_group) demoAgg[d.age_group] = (demoAgg[d.age_group] ?? 0) + 1;
		if (d.gender) genderAgg[d.gender] = (genderAgg[d.gender] ?? 0) + 1;
		for (const interest of d.interests ?? []) {
			interestAgg[interest] = (interestAgg[interest] ?? 0) + 1;
		}
	}
	const demoSummary = demoCount > 0
		? `年齢層: ${Object.entries(demoAgg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v}商品)`).join(", ")}
性別: ${Object.entries(genderAgg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v}商品)`).join(", ")}
主要関心事: ${Object.entries(interestAgg).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}(${v})`).join(", ")}
(${demoCount}商品のデータから集計)`
		: "（デモグラフィクスデータなし）";

	// Aggregate marketing strategies by type with counts and avg efficiency
	const stratAgg: Record<string, { count: number; totalEfficiency: number; examples: string[] }> = {};
	for (const p of ctx.products) {
		if (!p.research?.marketingStrategy) continue;
		for (const s of p.research.marketingStrategy) {
			if (!stratAgg[s.type]) stratAgg[s.type] = { count: 0, totalEfficiency: 0, examples: [] };
			stratAgg[s.type].count++;
			stratAgg[s.type].totalEfficiency += s.efficiency_score;
			if (stratAgg[s.type].examples.length < 3) stratAgg[s.type].examples.push(s.strategy_name);
		}
	}
	const stratLines = Object.entries(stratAgg)
		.sort((a, b) => b[1].count - a[1].count)
		.map(([type, d]) => `- ${type}: ${d.count}回推奨, 平均効率${Math.round(d.totalEfficiency / d.count)}/100, 例: ${d.examples.join(", ")}`)
		.join("\n");

	// Pricing data from Skill 3 for budget grounding
	const pricingSummary = pm.product_pricing.slice(0, 5).map((pp) => {
		const avgMargin = pp.channel_pricing.length > 0
			? Math.round(pp.channel_pricing.reduce((s, cp) => s + cp.net_margin_yen, 0) / pp.channel_pricing.length)
			: 0;
		return `- ${pp.product_name}: 平均粗利/個 ${formatYen(avgMargin)}`;
	}).join("\n");

	const bepSummary = pm.bep_analysis
		.map((b) => `- ${b.channel}: 損益分岐${b.bep_units}個/月, 達成見込${b.bep_timeline}`)
		.join("\n");

	// Channel priorities
	const channelPriorities = cs.channels
		.map((ch) => `- ${ch.name} (${ch.priority}): 適合度${ch.fit_score}, 広告最低額${ch.fee_structure.advertising_minimum}`)
		.join("\n");

	// Tier1 product lineup
	const tier1Summary = ps.channel_product_matrix
		.map((ch) => `- ${ch.channel}: ${ch.tier1_products.map((p) => p.name).join(", ")}`)
		.join("\n");

	return `[ROLE] あなたはEC・SNSマーケティングの実行プランナーです。TV通販からのEC展開における6ヶ月間の具体的なマーケティング実行計画を策定してください。
${buildGoalSection(ctx.parsedGoal)}
[DATA — 構造化データ]

=== ターゲット顧客プロファイル（全商品集計） ===
${demoSummary}

=== AI分析によるマーケティング戦略推奨（全商品集計） ===
${stratLines || "（マーケティング戦略データなし）"}

=== チャネル優先度・広告要件 ===
${channelPriorities}

=== 商品ラインナップ ===
${tier1Summary}

=== 商品別粗利データ（Skill 3） ===
${pricingSummary}

=== 損益分岐目標（Skill 3） ===
${bepSummary}

[PRIOR — 前ステップ分析結果]
- Skill 1（商品選定）: ${ps.channel_product_matrix.length}チャネルに商品を配分
- Skill 2（チャネル戦略）: launch_sequence = ${cs.launch_sequence.map((ls) => `${ls.phase}(${ls.channels.join(",")})`).join(" → ")}
- Skill 3（価格戦略）: 全商品の価格・BEP確定済み

[FRAMEWORK — 分析基準]

予算配分の判定基準:
- 月間マーケティング予算 = 目標月間売上 × 15-25%（立ち上げ期は25%、安定期は15%）
- チャネル別配分: immediate チャネルに60%, 3month チャネルに30%, その他10%
- 施策別配分: 広告40%, コンテンツ制作25%, インフルエンサー25%, PR10%
- BEP達成に必要な最低広告費を下回らないこと

インフルエンサー予算目安:
- mega (100万+フォロワー): ¥500,000-2,000,000/件
- macro (10-100万): ¥100,000-500,000/件
- micro (1-10万): ¥10,000-100,000/件

[TASK — 分析指示]

6ヶ月間の具体的なマーケティング実行計画を策定してください。
- monthly_plans: 各月のアクティビティに具体的な予算（¥）、想定インプレッション数、想定コンバージョン数を記載。
- content_calendar: 最初の2ヶ月（8週）の週別コンテンツ計画。
- influencer_plan: ティア別施策。
- budget_summary: 6ヶ月間の総予算と内訳。

IMPORTANT: すべて日本語で記述。金額は¥で表記。具体的な数値目標を含めること。

Return a JSON object (no markdown) with this structure:
{
  "monthly_plans": [{"month": "2026年4月", "total_budget": 0, "activities": [{"channel": "", "activity": "", "budget": 0, "expected_impressions": "", "expected_conversions": "", "content_type": ""}]}],
  "content_calendar": [{"week": "Week1", "channel": "", "content_type": "", "topic": "", "product_focus": ""}],
  "influencer_plan": [{"tier": "micro", "count": 0, "budget_per_person": "", "selection_criteria": "", "expected_roi": "", "platform": ""}],
  "budget_summary": {"total_6month": 0, "by_channel": {}, "by_type": {}},
  "sources_cited": [{"index": 1, "title": "", "url": ""}]
}
${buildSourcesSection(ctx)}`;
}

function buildFinancialProjectionPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const cs = (priorOutputs.channel_strategy as ChannelStrategyOutput) ?? EMPTY_CS;
	const pm = (priorOutputs.pricing_margin as PricingMarginOutput) ?? EMPTY_PM;
	const me = (priorOutputs.marketing_execution as MarketingExecutionOutput) ?? EMPTY_ME;

	// Compute weekly velocity trend (slope) from weeklyTrends
	let weeklySlope = 0;
	if (ctx.weeklyTrends.length >= 4) {
		const recent = ctx.weeklyTrends.slice(-12);
		const n = recent.length;
		const xMean = (n - 1) / 2;
		const yMean = recent.reduce((s, w) => s + w.revenue, 0) / n;
		let numerator = 0;
		let denominator = 0;
		for (let i = 0; i < n; i++) {
			numerator += (i - xMean) * (recent[i].revenue - yMean);
			denominator += (i - xMean) ** 2;
		}
		weeklySlope = denominator > 0 ? Math.round(numerator / denominator) : 0;
	}

	// Product baseline data: avgWeeklyQty for EC conversion projections
	const productBaselines = ctx.products.slice(0, 10).map((p) => {
		const m = ctx.computedMetrics[p.code];
		return `- ${p.name}: TV週平均${p.avgWeeklyQty}個, TV単価${formatYen(m.tvUnitPrice)}, 推移=${m.trajectory}`;
	}).join("\n");

	// Channel costs from Skill 2
	const channelCosts = cs.channels.map((ch) => {
		const bep = pm.bep_analysis.find((b) => b.channel === ch.name);
		return `- ${ch.name} (${ch.priority}): 初期投資=${ch.entry_requirements.initial_costs.map((c) => `${c.item}:${c.cost}`).join("+")}` +
			(bep ? `, BEP=${bep.bep_units}個/月, BEP達成=${bep.bep_timeline}` : "");
	}).join("\n");

	// Pricing summary from Skill 3
	const pricingSummary = pm.product_pricing.slice(0, 5).map((pp) => {
		const chPrices = pp.channel_pricing.map((cp) => `${cp.channel}:${formatYen(cp.recommended_price)}(粗利${cp.net_margin_pct}%)`).join(", ");
		return `- ${pp.product_name}: ${chPrices}`;
	}).join("\n");

	// Marketing budget from Skill 4
	const marketingBudget = `6ヶ月総額: ${formatYen(me.budget_summary.total_6month)}\n` +
		Object.entries(me.budget_summary.by_channel).map(([ch, amt]) => `  ${ch}: ${formatYen(amt)}`).join("\n");

	// Launch sequence from Skill 2
	const launchSequence = cs.launch_sequence
		.map((ls) => `- ${ls.phase}: ${ls.channels.join(", ")} (${ls.timeline}) — ${ls.rationale}`)
		.join("\n");

	// TV baseline
	const monthlyAvgRevenue = Math.round(ctx.annualMetrics.totalRevenue / Math.max(ctx.annualMetrics.weekCount / 4, 1));

	return `[ROLE] あなたは事業計画の財務モデリング専門家です。TV通販からのEC展開における12ヶ月間の収益予測を作成してください。
${buildGoalSection(ctx.parsedGoal)}
[DATA — 構造化データ]

=== TV通販ベースライン ===
- 月平均売上: ${formatYen(monthlyAvgRevenue)}
- 週次売上トレンド傾き: ${weeklySlope > 0 ? "+" : ""}${formatYen(weeklySlope)}/週（${weeklySlope > 0 ? "上昇傾向" : weeklySlope < 0 ? "下降傾向" : "横ばい"}）

=== 商品別TV実績ベースライン ===
${productBaselines}

=== 前提条件テーブル ===
| 項目 | 値 | 備考 |
|---|---|---|
| EC転換率（初月） | 5% | TV週平均販売数に対するEC販売比率 |
| EC転換率（3ヶ月後） | 15% | 広告・SEO効果反映 |
| EC転換率（6ヶ月後） | 25% | 安定期 |
| EC転換率（12ヶ月後） | 35% | 成熟期 |
| 月次成長率（立ち上げ期） | 15-25% | 1-3ヶ月目 |
| 月次成長率（成長期） | 10-15% | 4-6ヶ月目 |
| 月次成長率（安定期） | 5-8% | 7-12ヶ月目 |

=== チャネル別コスト構造（Skill 2） ===
${channelCosts}

=== 商品別チャネル価格・粗利（Skill 3） ===
${pricingSummary}

=== マーケティング予算（Skill 4） ===
${marketingBudget}

=== 展開スケジュール（Skill 2） ===
${launchSequence}

[PRIOR — 前ステップ分析結果]
- Skill 2: ${cs.channels.filter((c) => c.priority === "immediate").length}チャネルを即時展開、フェーズ展開計画確定
- Skill 3: BEP分析完了、商品別チャネル価格確定
- Skill 4: 6ヶ月マーケティング予算 ${formatYen(me.budget_summary.total_6month)}

[FRAMEWORK — 分析基準]

収益予測ルール:
- 各チャネルはlaunch_sequenceに従って段階的に立ち上げ
- 立ち上げ前のチャネルは売上ゼロ
- 初月売上 = tier1商品のTV週平均 × 4週 × EC転換率5% × EC推奨価格
- 成長率は前提条件テーブルに従う
- マーケティング費はSkill 4の月別予算を使用
- ROI = (年間純利益 - 総投資額) / 総投資額 × 100

シナリオ分岐:
- 保守的: EC転換率を50%に、成長率を-5%ずつ
- 中立的: 前提条件テーブル通り
- 積極的: EC転換率を150%に、成長率を+5%ずつ

[TASK — 分析指示]

12ヶ月間（2026年4月〜2027年3月）の収益予測を作成してください。

IMPORTANT: すべて日本語で記述。金額はすべて日本円。

Return a JSON object (no markdown) with this structure:
{
  "monthly_forecast": [{"month": "2026年4月", "by_channel": [{"channel": "", "revenue": 0, "cost": 0, "marketing_spend": 0, "net_profit": 0, "cumulative_profit": 0}], "total_revenue": 0, "total_profit": 0}],
  "roi_timeline": [{"channel": "", "total_investment": 0, "breakeven_month": "", "year1_roi_pct": 0, "year1_net_profit": 0}],
  "scenarios": {"conservative": {"year1_revenue": 0, "year1_profit": 0}, "moderate": {"year1_revenue": 0, "year1_profit": 0}, "aggressive": {"year1_revenue": 0, "year1_profit": 0}, "assumptions": []},
  "sources_cited": [{"index": 1, "title": "", "url": ""}]
}
${buildSourcesSection(ctx)}`;
}

function buildRiskContingencyPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const cs = (priorOutputs.channel_strategy as ChannelStrategyOutput) ?? EMPTY_CS;
	const pm = (priorOutputs.pricing_margin as PricingMarginOutput) ?? EMPTY_PM;
	const fp = (priorOutputs.financial_projection as FinancialProjectionOutput) ?? EMPTY_FP;

	// Full competitive landscape and operations requirements from Skill 2
	const channelDetailLines = cs.channels.map((ch) => {
		const roi = fp.roi_timeline.find((r) => r.channel === ch.name);
		const bep = pm.bep_analysis.find((b) => b.channel === ch.name);
		return `=== ${ch.name} (${ch.priority}) ===
- 適合度: ${ch.fit_score}/100
- 初期投資: ${ch.entry_requirements.initial_costs.map((c) => `${c.item}:${c.cost}`).join(", ")}
- 手数料: ${ch.fee_structure.commission_rate}, 月額: ${ch.fee_structure.monthly_fee}
- 競合環境: ${ch.competitive_landscape.competitor_count}社, 価格帯${ch.competitive_landscape.price_range}, 主要: ${ch.competitive_landscape.dominant_players.join(", ")}
- 差別化機会: ${ch.competitive_landscape.differentiation_opportunity}
- 運営: 在庫=${ch.operations_requirements.inventory_model}, CS=${ch.operations_requirements.cs_requirements}, コンテンツ=${ch.operations_requirements.content_requirements.join(", ")}
- 更新頻度: ${ch.operations_requirements.update_frequency}
${bep ? `- BEP: ${bep.bep_units}個/月, 達成見込: ${bep.bep_timeline}` : ""}
${roi ? `- 1年目ROI: ${roi.year1_roi_pct}%, 純利益: ${formatYen(roi.year1_net_profit)}` : ""}`;
	}).join("\n\n");

	// Sunk cost calculations (all channels)
	const sunkCostLines = cs.channels.map((ch) => {
		const totalInitial = ch.entry_requirements.initial_costs
			.map((c) => {
				const match = c.cost.match(/(\d[\d,]*)/);
				return match ? parseInt(match[1].replace(/,/g, ""), 10) : 0;
			})
			.reduce((s, v) => s + v, 0);
		return `- ${ch.name}: 初期サンクコスト ≈ ${formatYen(totalInitial)}`;
	}).join("\n");

	// BEP thresholds (all channels)
	const bepThresholds = pm.bep_analysis
		.map((b) => {
			const monthlyFixedTotal = b.fixed_costs.reduce((s, f) => s + f.monthly, 0);
			return `- ${b.channel}: BEP=${b.bep_units}個/月, 月間固定費=${formatYen(monthlyFixedTotal)}`;
		}).join("\n");

	// Scenarios
	const scenarios = fp.scenarios;

	return `[ROLE] あなたはEC事業のリスクマネジメント専門家です。TV通販からのEC展開における包括的なリスク分析と対策計画を策定してください。
${buildGoalSection(ctx.parsedGoal)}
[DATA — 構造化データ]

=== チャネル別詳細データ（Skill 2 + Skill 3 + Skill 5） ===
${channelDetailLines}

=== サンクコスト一覧 ===
${sunkCostLines}

=== BEP撤退基準（Skill 3） ===
${bepThresholds}

=== 収益シナリオ（Skill 5） ===
- 保守的: 年間売上${formatYen(scenarios.conservative.year1_revenue)}, 利益${formatYen(scenarios.conservative.year1_profit)}
- 中立的: 年間売上${formatYen(scenarios.moderate.year1_revenue)}, 利益${formatYen(scenarios.moderate.year1_profit)}
- 積極的: 年間売上${formatYen(scenarios.aggressive.year1_revenue)}, 利益${formatYen(scenarios.aggressive.year1_profit)}
前提: ${scenarios.assumptions.join(", ")}

[PRIOR — 前ステップ分析結果]
- Skill 2: 競合環境・運営要件が各チャネルで確定
- Skill 3: BEP閾値と損益分岐達成見込を確認済み
- Skill 5: 3シナリオの収益予測完了、ROIタイムライン確定

[FRAMEWORK]
- リスク評価: likelihood × impact (high=3/medium=2/low=1)
- 撤退検討: BEPの50%未達が3ヶ月連続 / 累積損失がサンクコスト200%超
- Go/No-Go判断は3ヶ月後・6ヶ月後

[TASK]
上記の${cs.channels.length}チャネルについて、簡潔だが具体的なリスク分析を策定。
- risk_matrix: 各チャネル最大3リスクのみ。
- top_5_risks: 全体TOP5のみ。playbookは3ステップ以内。
- go_nogo_criteria: 各チャネル1セットのみ。

すべて日本語、具体的な数値基準で。出力は簡潔に。

Return a JSON object (no markdown):
{
  "risk_matrix": [{"channel":"","risks":[{"risk":"","category":"","likelihood":"high|medium|low","impact":"high|medium|low","mitigation":[],"contingency_trigger":"","contingency_action":""}]}],
  "top_5_risks": [{"risk":"","channel":"","mitigation_playbook":[],"owner":"","review_frequency":""}],
  "go_nogo_criteria": [{"channel":"","criteria":[],"decision_date":""}]
}`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

type PromptBuilder = (ctx: StrategyContext, priorOutputs: Record<string, unknown>) => string;

const SKILL_PIPELINE: Array<{ name: SkillName; buildPrompt: PromptBuilder }> = [
	{ name: "goal_analysis", buildPrompt: () => "" }, // handled specially in orchestrator
	{ name: "product_selection", buildPrompt: (ctx) => buildProductSelectionPrompt(ctx) },
	{ name: "channel_strategy", buildPrompt: buildChannelStrategyPrompt },
	{ name: "pricing_margin", buildPrompt: buildPricingMarginPrompt },
	{ name: "marketing_execution", buildPrompt: buildMarketingExecutionPrompt },
	{ name: "financial_projection", buildPrompt: buildFinancialProjectionPrompt },
	{ name: "risk_contingency", buildPrompt: buildRiskContingencyPrompt },
];

// Public single-skill runner — used by the workflow path so each skill can run as its own step.
export async function runMDSkill(
	skillName: SkillName,
	context: StrategyContext,
	priorOutputs: Record<string, unknown>,
): Promise<unknown> {
	if (skillName === "goal_analysis") {
		return context.userGoal ? await runGoalAnalysis(context.userGoal) : null;
	}
	const skill = SKILL_PIPELINE.find((s) => s.name === skillName);
	if (!skill) throw new Error(`Unknown skill: ${skillName}`);
	const prompt = skill.buildPrompt(context, priorOutputs);
	const raw = await callGemini(prompt);
	const parsed = parseJSON<Record<string, unknown>>(raw);
	if (skillName === "product_selection" && context.recommendedProducts && context.recommendedProducts.length > 0) {
		const ps = parsed as unknown as ProductSelectionOutput;
		ps.discovered_new_products = context.recommendedProducts;
		ps.discovery_history = [{
			generatedAt: new Date().toISOString(),
			products: context.recommendedProducts,
		}];
	}
	return parsed;
}

export const MD_SKILL_NAMES: SkillName[] = [
	"goal_analysis",
	"product_selection",
	"channel_strategy",
	"pricing_margin",
	"marketing_execution",
	"financial_projection",
	"risk_contingency",
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
			if (skill.name === "goal_analysis") {
				// Skill 0: Goal Analysis — only runs if userGoal is provided
				if (context.userGoal) {
					const parsedGoal = await runGoalAnalysis(context.userGoal);
					context.parsedGoal = parsedGoal;
					outputs.goal_analysis = parsedGoal;
					onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: parsedGoal });
				} else {
					outputs.goal_analysis = null;
					onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: null });
				}
				continue;
			}

			const prompt = skill.buildPrompt(context, outputs);
			const raw = await callGemini(prompt);
			const parsed = parseJSON<Record<string, unknown>>(raw);

			// Inject discovered new products into the product_selection output
			// so the UI can render them as a top-level "発掘新商品" section.
			if (skill.name === "product_selection") {
				if (context.recommendedProducts && context.recommendedProducts.length > 0) {
					const ps = parsed as unknown as ProductSelectionOutput;
					ps.discovered_new_products = context.recommendedProducts;
					ps.discovery_history = [{
						generatedAt: new Date().toISOString(),
						products: context.recommendedProducts,
					}];
					console.log(`[orchestrator] spliced ${context.recommendedProducts.length} discovered products into product_selection`);
				} else {
					console.warn(`[orchestrator] context.recommendedProducts is empty/undefined — no hero will render`);
				}
			}

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
