import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import { buildChannelReferencePrompt } from "@/lib/tv-channels";
import { callGeminiWithRetry } from "@/lib/gemini/retry";
import { researchOutputSchema } from "@/lib/gemini/research-schema";
import { parseResearchOutput } from "@/lib/gemini/parse-research-output";
import type { GeminiErrorKind } from "@/lib/gemini/errors";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export interface ProductInfo {
	name: string;
	description: string;
	features: string[];
	category: string;
	price_range?: string;
	target_market?: string;
}

export interface ResearchOutput {
	marketability_score: number;
	marketability_description: string;
	demographics: {
		age_group: string;
		gender: string;
		interests: string[];
		income_level: string;
	};
	seasonality: Record<string, number>;
	cogs_estimate: {
		items: Array<{
			supplier: string;
			estimated_cost: string;
			moq: string;
			link?: string;
		}>;
		summary: string;
	};
	influencers: Array<{
		name: string;
		platform: string;
		followers: string;
		match_reason: string;
		profile_url?: string;
	}>;
	content_ideas: Array<{
		title: string;
		description: string;
		format: string;
	}>;
	competitor_analysis: Array<{
		name: string;
		price: string;
		platform: string;
		key_difference: string;
	}>;
	recommended_price_range: string;
	broadcast_scripts: {
		sec30: string;
		sec60: string;
		min5: string;
	};
	japan_export_fit_score: number;
	// Extended analysis sections
	distribution_channels?: Array<{
		channel_name: string;
		channel_type: string;
		primary_age_group: string;
		fit_score: number;
		reason: string;
		monthly_visitors?: string;
		commission_rate?: string;
		url?: string;
		broadcaster?: string;
		evidence_sources?: Array<{ title: string; url: string; snippet: string }>;
		similar_products_on_channel?: Array<{ product_name: string; price?: string; source_url?: string }>;
		scoring_breakdown?: {
			demographic_match: number;
			category_track_record: number;
			price_point_fit: number;
			presentation_format_fit: number;
		};
	}>;
	pricing_strategy?: {
		channel_pricing: Array<{
			channel: string;
			benchmark_price: string;
			recommended_price: string;
			estimated_margin_pct: number;
			reason: string;
		}>;
		bep_analysis: {
			estimated_cogs_per_unit: string;
			fixed_cost_assumption: string;
			bep_units_per_channel: Array<{
				channel: string;
				bep_units: number;
				bep_revenue: string;
			}>;
			summary: string;
		};
	};
	marketing_strategy?: Array<{
		strategy_name: string;
		type: string;
		estimated_cost: string;
		expected_reach: string;
		efficiency_score: number;
		steps: string[];
		best_for_channels: string[];
	}>;
	korea_market_fit?: {
		fit_score: number;
		target_products: string[];
		recommended_channels: Array<{
			channel_name: string;
			target_age: string;
			strategy: string;
			estimated_entry_cost: string;
		}>;
		korean_consumer_insight: string;
	};
	live_commerce?: {
		platforms: Array<{
			platform_name: string;
			platform_type: string;
			target_audience: string;
			fit_score: number;
			reason: string;
		}>;
		scripts: {
			instagram_live: string;
			tiktok_live: string;
			youtube_live: string;
		};
		talking_points: string[];
		engagement_tips: string[];
		recommended_products_angle: string;
	};
}

export function parseJsonFromModelText<T>(raw: string, context: string): T {
	let cleaned = raw.trim();
	const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fenceMatch) cleaned = fenceMatch[1].trim();

	try {
		return JSON.parse(cleaned) as T;
	} catch {
		// Fall through to extracting a balanced JSON object/array from surrounding prose.
	}

	const objectStart = cleaned.indexOf("{");
	const arrayStart = cleaned.indexOf("[");
	if (objectStart === -1 && arrayStart === -1) {
		throw new Error(
			`Failed to parse JSON from ${context}: no JSON object or array found. Head: ${cleaned.slice(0, 200)}`,
		);
	}

	const startsWithObject = arrayStart === -1 || (objectStart !== -1 && objectStart < arrayStart);
	const start = startsWithObject ? objectStart : arrayStart;
	const open = startsWithObject ? "{" : "[";
	const close = startsWithObject ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;

	for (let i = start; i < cleaned.length; i += 1) {
		const ch = cleaned[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === open) {
			depth += 1;
		} else if (ch === close) {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}

	if (end === -1) {
		throw new Error(
			`Failed to parse JSON from ${context}: unbalanced ${open}. Head: ${cleaned.slice(0, 200)}`,
		);
	}

	const jsonText = cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
	try {
		return JSON.parse(jsonText) as T;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to parse JSON from ${context}: ${message}. Head: ${jsonText.slice(0, 200)}`,
		);
	}
}

export interface ExtractFile {
	base64: string;
	mimeType: string;
	fileName: string;
}

export async function extractProductInfo(
	files: ExtractFile[],
): Promise<ProductInfo> {
	if (files.length === 0) {
		throw new Error("extractProductInfo called with empty files array");
	}
	const model = genAI.getGenerativeModel({ model: GEMINI_FLASH });

	const fileList = files.map((f, i) => `${i + 1}. ${f.fileName} (${f.mimeType})`).join("\n");

	const prompt = `あなたはホームショッピングチャネル向けの商品アナリストです。添付ファイルを解析し、商品情報をすべて抽出してください。

複数のファイルが添付されている場合、すべて同一商品の異なる面 (表面/裏面/パッケージ/詳細写真/カタログPDF 等) として総合的に判断してください。複数の異なる商品が混在する場合は、最も主要な1つに絞ってください。

出力 JSON のすべての値は日本語で記述してください。商品名/カテゴリ/特徴/対象市場/価格帯すべて日本語のみ。

JSONオブジェクトを返してください (フィールド):
- name: 商品名 (string)
- description: 詳細な商品説明 (string)
- features: 主な商品特徴 (string の配列)
- category: 商品カテゴリ (string)
- price_range: 言及されていれば価格帯 (string, optional)
- target_market: 言及されていればターゲット市場 (string, optional)

添付ファイル一覧:
${fileList}

JSONオブジェクトのみ返してください。コードフェンス・前後の説明文は禁止。`;

	const parts: Part[] = [{ text: prompt }];
	for (const f of files) {
		parts.push({ inlineData: { mimeType: f.mimeType, data: f.base64 } });
	}

	return await callGeminiWithRetry(
		async (_attempt, override) => {
			const effectiveParts: Part[] = override
				? [{ text: `${prompt}\n\n${override}` }, ...parts.slice(1)]
				: parts;
			const result = await model.generateContent(effectiveParts);
			const text = result.response.text().trim();
			return {
				result: parseJsonFromModelText<ProductInfo>(text, "product extraction"),
				responseText: text,
			};
		},
		{
			maxAttempts: 3,
			baseDelayMs: 1000,
			promptForAttempt: (_attempt, kind) => {
				if (!kind) return null;
				if (kind === "parse_failed") {
					return "前回の応答は不正なJSONでした。コードフェンスや前後の説明文を一切付けず、単一のJSONオブジェクトのみ返してください。";
				}
				if (kind === "extract_empty") {
					return "前回の応答は空でした。必須キー (name, description, features, category) をすべて明示的に出力してください。";
				}
				return null;
			},
		},
	);
}

export async function synthesizeResearch(
	productInfo: ProductInfo,
	searchResults: Record<string, string>,
	broadcastContextPrompt?: string,
): Promise<ResearchOutput> {
	const modelName = GEMINI_FLASH;
	const model = genAI.getGenerativeModel({
		model: modelName,
		generationConfig: {
			maxOutputTokens: 32768,
			responseMimeType: "application/json",
			responseSchema: researchOutputSchema,
		},
	});

	const contextSections: string[] = [];
	contextSections.push("=== 入力商品情報 ===");
	contextSections.push(JSON.stringify(productInfo, null, 2));
	contextSections.push("");
	contextSections.push("=== Web検索結果 (Brave + Rakuten) ===");
	contextSections.push(
		Object.entries(searchResults)
			.map(([key, val]) => `## ${key}\n${val}`)
			.join("\n\n"),
	);
	if (broadcastContextPrompt && broadcastContextPrompt.trim().length > 0) {
		contextSections.push("");
		contextSections.push("=== 競合放送コンテキスト ===");
		contextSections.push(broadcastContextPrompt.trim());
	}
	contextSections.push("");
	contextSections.push("=== TVチャネル参考 ===");
	contextSections.push(buildChannelReferencePrompt());

	const businessGuide = `=== 出力ガイド ===
あなたは日本市場参入を専門とするホームショッピング・マーケティングリサーチアナリストです。
上記のコンテキストを根拠として、商品の市場性を多面的に分析してください。

ALL text values MUST be Japanese. Product names, URLs, numeric values may keep original form.

=== TV通販チャネル適合度 評価基準 ===
各チャネルのfit_scoreは4項目 (各0-25点) の合計で算出:
1. demographic_match (0-25): 商品ターゲット層とチャネル視聴者層の重なり (検索結果から視聴者データを引用 / データなし最大15点)
2. category_track_record (0-25): 類似カテゴリ商品の販売実績 (similar_products_on_channelに実商品名 / 実績データなし最大10点)
3. price_point_fit (0-25): 商品価格帯とチャネル平均価格帯の適合 (楽天/Amazon/競合データから根拠 / データなし最大15点)
4. presentation_format_fit (0-25): TV実演向き度合い (商品特性に基づく客観評価 / データなし最大15点)

CRITICAL RULES:
- evidence_sources は上記 Web Search Results に実在するURLのみ
- 検索データが全くないチャネルは fit_score 合計を 55 点以下に
- reason は「〇〇によると...」の形式でソースを引用
- similar_products_on_channel は検索で確認できた実在商品のみ

=== 件数ガイド ===
- competitor_analysis: 3件 (exact)
- distribution_channels: 6-10件 (TV通販の高 fit_score チャネル + 2-4 EC/その他)
  - fit_score = scoring_breakdown 4 項目の合計 (max 100)
  - evidence_sources: 各チャネル最大 2 件
- pricing_strategy.channel_pricing: 2-4 件
- marketing_strategy: 3-5 件 (efficiency_score 降順)
- live_commerce: 3 platforms / talking_points 5 / engagement_tips 3
- influencers: 3-5 件 / content_ideas: 3-5 件
- broadcast_scripts は日本語、JSON 1 行に収まる長さに

すべての必須フィールドを必ず明示生成してください。`;

	const basePrompt = `${contextSections.join("\n")}\n\n${businessGuide}`;

	return await callGeminiWithRetry(
		async (_attempt, override) => {
			const prompt = override ? `${basePrompt}\n\n${override}` : basePrompt;
			const result = await model.generateContent(prompt);
			const text = result.response.text().trim();
			return { result: parseResearchOutput(text), responseText: text };
		},
		{
			maxAttempts: 3,
			baseDelayMs: 1000,
			promptForAttempt: (_attempt, kind) => buildSynthesizeAttemptOverride(kind),
		},
	);
}

function buildSynthesizeAttemptOverride(kind: GeminiErrorKind | undefined): string | null {
	if (!kind) return null;
	switch (kind) {
		case "parse_failed":
			return "前回の応答は不正なJSONでした。コードフェンスや前後の説明文を一切付けず、単一のJSONオブジェクトのみ返してください。";
		case "schema_validation_failed":
			return "前回の応答はスキーマ違反でした。すべての required フィールドを明示的に出力し、列挙値や数値範囲を厳守してください。";
		case "extract_empty":
			return "前回の応答は空でした。すべての required フィールドを必ず明示的に生成してください。空文字列禁止。";
		case "rate_limited":
		case "server_error":
		case "unknown":
		default:
			return null;
	}
}
// ---------------------------------------------------------------------------
// Expansion Strategy Analysis
// ---------------------------------------------------------------------------

export interface ExpansionInput {
	topProducts: Array<{
		code: string;
		name: string;
		category: string | null;
		totalRevenue: number;
		totalProfit: number;
		totalQuantity: number;
		marginRate: number;
		avgWeeklyQty: number;
		weekCount: number;
	}>;
	categorySummary: Record<string, { revenue: number; quantity: number }>;
	overallRevenue: number;
	overallProfit: number;
	overallMarginRate: number;
	weekCount: number;
	userGoal?: string;
	seedProductId?: string;
}

export interface RecommendedProduct {
	name: string;
	tv_revenue: string;
	margin: string;
	weekly_avg: number;
	fit_reason: string;
}

export interface ExpansionAnalysisResult {
	channel_recommendations: Array<{
		channel: string;
		fit_score: number;
		reasoning: string;
		estimated_market_size: string;
		recommended_products: RecommendedProduct[];
		entry_difficulty: string;
	}>;
	product_channel_fit: Array<{
		product: string;
		best_channels: string[];
		reasoning: string;
	}>;
	entry_strategy: Array<{
		channel: string;
		steps: string[];
		timeline: string;
		initial_investment: string;
	}>;
	risk_assessment: Array<{
		channel: string;
		risks: string[];
		mitigation: string;
	}>;
	summary: string;
}

export async function analyzeExpansionStrategy(
	input: ExpansionInput,
): Promise<ExpansionAnalysisResult> {
	const model = genAI.getGenerativeModel({ model: GEMINI_FLASH });

	const productLines = input.topProducts
		.map(
			(p, i) =>
				`${i + 1}. ${p.name} [${p.category ?? "分類なし"}] — 総売上: ¥${p.totalRevenue.toLocaleString()}, 粗利率: ${p.marginRate}%, 週平均${p.avgWeeklyQty}個, ${p.weekCount}週間販売`,
		)
		.join("\n");

	const categoryLines = Object.entries(input.categorySummary)
		.sort(([, a], [, b]) => b.revenue - a.revenue)
		.map(([cat, d]) => `  - ${cat}: ¥${d.revenue.toLocaleString()} (${d.quantity.toLocaleString()}個)`)
		.join("\n");

	const userGoalSection = input.userGoal
		? `\n=== ユーザーの目標 ===\n${input.userGoal}\n\n上記の目標を最優先に踏まえて分析してください。目標に関連するチャネルをより重点的に分析してください。\n`
		: "";

	const prompt = `あなたはTV通販（テレビ東京ダイレクト）の販売チャネル拡大戦略コンサルタントです。

以下の実績データに基づき、TV通販以外のチャネルへの拡大戦略を分析してください。
${userGoalSection}
=== 全体実績サマリー ===
- 総売上: ¥${input.overallRevenue.toLocaleString()}
- 総粗利: ¥${input.overallProfit.toLocaleString()}
- 粗利率: ${input.overallMarginRate}%
- 集計期間: ${input.weekCount}週間 (2025-2026年)

=== カテゴリ別売上 ===
${categoryLines}

=== 上位15商品実績 ===
${productLines}

=== 分析対象チャネル ===
1. Amazon Japan
2. 楽天市場
3. Yahoo!ショッピング
4. TikTok Shop Japan
5. Instagram Shopping
6. 越境EC（韓国：Coupang / 東南アジア：Shopee, Lazada）
7. 自社EC（D2C）

=== 分析ルール ===
IMPORTANT: 各チャネルの推奨商品には、必ず上記の「上位15商品実績」から具体的な数値（売上、粗利率、週平均販売数）を引用してください。
根拠のない推奨は行わないでください。推奨理由には「TV通販で週平均○○個、粗利率○○%の実績があるため」のように必ずデータを引用すること。

各チャネルについて、以下を日本語で分析してください：
- 上記商品との適合度（0-100スコア）
- 最適な商品の選定理由（必ず売上データを引用）
- 参入戦略ステップ
- リスク評価

Return a JSON object (no markdown) with this structure:
{
  "channel_recommendations": [{"channel": "", "fit_score": 0, "reasoning": "", "estimated_market_size": "", "recommended_products": [{"name": "", "tv_revenue": "¥○○万", "margin": "○○%", "weekly_avg": 0, "fit_reason": ""}], "entry_difficulty": ""}],
  "product_channel_fit": [{"product": "", "best_channels": [], "reasoning": ""}],
  "entry_strategy": [{"channel": "", "steps": [], "timeline": "", "initial_investment": ""}],
  "risk_assessment": [{"channel": "", "risks": [], "mitigation": ""}],
  "summary": ""
}`;

	const result = await model.generateContent(prompt);
	const text = result.response.text().trim();
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("Failed to generate expansion analysis");

	return JSON.parse(jsonMatch[0]) as ExpansionAnalysisResult;
}
