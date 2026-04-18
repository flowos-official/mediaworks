import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildChannelReferencePrompt } from "@/lib/tv-channels";

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

export async function extractProductInfo(
	fileBase64: string,
	mimeType: string,
	fileName: string,
): Promise<ProductInfo> {
	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

	const prompt = `You are a product analyst for home shopping channels. Analyze this file and extract all product information.

Return a JSON object with these fields:
- name: Product name (string)
- description: Detailed product description (string)
- features: Key product features (array of strings)
- category: Product category (string)
- price_range: Price range if mentioned (string, optional)
- target_market: Target market if mentioned (string, optional)

File name: ${fileName}

Return only valid JSON, no markdown.`;

	const result = await model.generateContent([
		{
			inlineData: {
				mimeType,
				data: fileBase64,
			},
		},
		prompt,
	]);

	const text = result.response.text().trim();
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("Failed to extract product info from file");

	return JSON.parse(jsonMatch[0]) as ProductInfo;
}

export async function synthesizeResearch(
	productInfo: ProductInfo,
	searchResults: Record<string, string>,
): Promise<ResearchOutput> {
	// Use gemini-3-flash-preview (stable, fast)
	const modelName = "gemini-3-flash-preview";
	const model = genAI.getGenerativeModel({
		model: modelName,
		generationConfig: { maxOutputTokens: 16384 },
	});

	const prompt = `You are a home shopping marketing research analyst specializing in Japan market expansion. Based on the product information and web search results, generate a comprehensive research report.

IMPORTANT: ALL text fields in the JSON response MUST be written in Japanese (日本語). This includes marketability_description, demographics fields, influencer match_reason, content_ideas titles and descriptions, competitor key_difference, broadcast_scripts, recommended_price_range descriptions, and any other text. Only product names, URLs, and numeric values may remain in their original language.

Product Information:
${JSON.stringify(productInfo, null, 2)}

Web Search Results:
${Object.entries(searchResults)
		.map(([key, val]) => `## ${key}\n${val}`)
		.join("\n\n")}

${buildChannelReferencePrompt()}

=== TV通販チャネル適合度 評価基準 ===
各チャネルのfit_scoreは以下4項目（各0-25点）の合計で算出してください：

1. demographic_match (0-25): 商品のターゲット層とチャネル視聴者層の重なり度合い
   - 検索結果から視聴者データを引用すること
   - データなし = 最大15点

2. category_track_record (0-25): このチャネルで類似カテゴリ商品が販売された実績
   - similar_products_on_channelに実際の商品名を記載（検索結果から）
   - 実績データなし = 最大10点

3. price_point_fit (0-25): 商品価格帯とチャネルの平均販売価格帯の適合度
   - 楽天/Amazon/競合データから根拠を示すこと
   - データなし = 最大15点

4. presentation_format_fit (0-25): TV実演向きかどうか（ビフォーアフター、触感、視覚的インパクト）
   - 商品特性に基づく客観評価
   - データなし = 最大15点

CRITICAL RULES:
- evidence_sourcesには上記Web Search Resultsに実際に含まれるURLのみ記載可
- 検索結果にデータが全くないチャネルはfit_score合計を55点以下に設定（15+10+15+15=55が上限目安）
- reasonフィールドは「〇〇によると...」の形式でソースを引用
- similar_products_on_channelは検索で確認できた実在商品のみ記載（捏造厳禁）

Generate a JSON response with these exact fields:
{
  "marketability_score": <number 0-100>,
  "marketability_description": "<detailed explanation of market potential in 2-3 sentences>",
  "demographics": {
    "age_group": "<e.g., '25-45 years'>",
    "gender": "<e.g., 'Primarily female (70%)'>",
    "interests": ["<interest1>", "<interest2>", "<interest3>"],
    "income_level": "<e.g., 'Middle to upper-middle class'>"
  },
  "seasonality": {
    "jan": <0-100>, "feb": <0-100>, "mar": <0-100>, "apr": <0-100>,
    "may": <0-100>, "jun": <0-100>, "jul": <0-100>, "aug": <0-100>,
    "sep": <0-100>, "oct": <0-100>, "nov": <0-100>, "dec": <0-100>
  },
  "cogs_estimate": {
    "items": [
      {
        "supplier": "<supplier name>",
        "estimated_cost": "<e.g., '$5-8 USD'>",
        "moq": "<minimum order quantity>",
        "link": "<optional URL>"
      }
    ],
    "summary": "<brief summary of COGS analysis>"
  },
  "influencers": [
    {
      "name": "<influencer name or type>",
      "platform": "<YouTube/Instagram/TikTok>",
      "followers": "<e.g., '500K-1M'>",
      "match_reason": "<why this influencer fits the product>",
      "profile_url": "<optional URL>"
    }
  ],
  "content_ideas": [
    {
      "title": "<content title>",
      "description": "<content description>",
      "format": "<Video/Blog/Social Post/etc>"
    }
  ],
  "competitor_analysis": [
    {
      "name": "<competitor product name>",
      "price": "<price in USD or JPY>",
      "platform": "<where it's sold — Amazon, Rakuten, etc>",
      "key_difference": "<key difference from our product>"
    }
  ],
  "recommended_price_range": "<recommended retail price range for Japan home shopping, e.g., '¥3,980-5,980'>",
  "broadcast_scripts": {
    "sec30": "<30-second home shopping broadcast script in Japanese>",
    "sec60": "<60-second home shopping broadcast script in Japanese>",
    "min5": "<5-minute detailed home shopping broadcast script in Japanese with host cues>"
  },
  "japan_export_fit_score": <number 0-100, how well this product fits Japan market>,
  "distribution_channels": [
    {
      "channel_name": "<channel name>",
      "channel_type": "<TV通販 | EC | SNSコマース | カタログ通販 | クラウドファンディング | メディア | オフライン | その他>",
      "primary_age_group": "<e.g. 40-60代女性>",
      "fit_score": <MUST equal demographic_match + category_track_record + price_point_fit + presentation_format_fit, max 100>,
      "reason": "<evidence-based explanation citing sources, in Japanese>",
      "monthly_visitors": "<optional, e.g. 月間5,000万人>",
      "commission_rate": "<optional, e.g. 10-15%>",
      "url": "<channel URL>",
      "broadcaster": "<TV broadcaster name, if applicable>",
      "evidence_sources": [
        { "title": "<source title from search results>", "url": "<URL from search results above>", "snippet": "<relevant excerpt>" }
      ],
      "similar_products_on_channel": [
        { "product_name": "<actual product found in search>", "price": "<if available>", "source_url": "<URL>" }
      ],
      "scoring_breakdown": {
        "demographic_match": <0-25>,
        "category_track_record": <0-25>,
        "price_point_fit": <0-25>,
        "presentation_format_fit": <0-25>
      }
    }
  ],
  "pricing_strategy": {
    "channel_pricing": [
      {
        "channel": "<channel name>",
        "benchmark_price": "<competitor avg price, e.g. ¥3,980>",
        "recommended_price": "<our recommended price, e.g. ¥4,980>",
        "estimated_margin_pct": <margin percentage number>,
        "reason": "<why this price makes sense>"
      }
    ],
    "bep_analysis": {
      "estimated_cogs_per_unit": "<e.g. ¥1,200>",
      "fixed_cost_assumption": "<e.g. 初期固定費 ¥500,000>",
      "bep_units_per_channel": [
        {
          "channel": "<channel name>",
          "bep_units": <integer>,
          "bep_revenue": "<e.g. ¥498,000>"
        }
      ],
      "summary": "<BEP analysis summary in Japanese>"
    }
  },
  "marketing_strategy": [
    {
      "strategy_name": "<strategy name>",
      "type": "<SNS | インフルエンサー | PR | SEO | イベント>",
      "estimated_cost": "<e.g. ¥50,000-200,000/月>",
      "expected_reach": "<e.g. 50,000 impressions/月>",
      "efficiency_score": <0-100>,
      "steps": ["<step 1>", "<step 2>", "<step 3>"],
      "best_for_channels": ["<channel1>", "<channel2>"]
    }
  ],
  "korea_market_fit": {
    "fit_score": <0-100>,
    "target_products": ["<product variant 1>", "<product variant 2>"],
    "recommended_channels": [
      {
        "channel_name": "<e.g. Coupang, Naver SmartStore, Olive Young, MUSINSA>",
        "target_age": "<e.g. 20-30代女性>",
        "strategy": "<entry strategy in Japanese>",
        "estimated_entry_cost": "<e.g. 月100万ウォン>"
      }
    ],
    "korean_consumer_insight": "<Korean consumer characteristics analysis in Japanese>"
  },
  "live_commerce": {
    "platforms": [
      {
        "platform_name": "<e.g. Instagram Live, TikTok Live, YouTube Live, 楽天ROOM LIVE>",
        "platform_type": "<SNS | EC連携 | 独自プラットフォーム>",
        "target_audience": "<e.g. 20-30代女性、美容・ファッション関心層>",
        "fit_score": <0-100>,
        "reason": "<why this platform fits the product, in Japanese>"
      }
    ],
    "scripts": {
      "instagram_live": "<3-5 minute Instagram Live script in Japanese with host cues, product demo timing, CTA>",
      "tiktok_live": "<3-5 minute TikTok Live script in Japanese, fast-paced, trend-aware, with engagement hooks>",
      "youtube_live": "<5-10 minute YouTube Live script in Japanese, detailed product review style, with Q&A prompts>"
    },
    "talking_points": ["<key selling point 1>", "<key selling point 2>", "<key selling point 3>", "<key selling point 4>", "<key selling point 5>"],
    "engagement_tips": ["<tip for boosting live viewer engagement 1>", "<tip 2>", "<tip 3>"],
    "recommended_products_angle": "<the best angle/narrative for presenting this product in live commerce, in Japanese>"
  }
}

IMPORTANT:
- Provide exactly 3 competitor products in competitor_analysis
- Provide 16-22 distribution_channels. MUST include ALL 13 Japanese TV shopping channels listed above. fit_score MUST equal the sum of 4 scoring_breakdown values (each 0-25, total 0-100). Include evidence_sources (URLs from search results only). Include 3-9 EC/other channels.
- Provide 3-4 channel_pricing entries in pricing_strategy
- Provide 3-5 marketing_strategy items sorted by efficiency_score desc
- live_commerce should include 3-4 platform analyses, scripts for each major platform, and 5 talking points
- korea_market_fit should analyze Korea-specific consumer patterns and channels
- recommended_price_range should be based on Japan home shopping market pricing (in JPY)
- broadcast_scripts should be written in Japanese (日本語) as these are for Japan home shopping broadcasts
- japan_export_fit_score should consider: Japan consumer preferences, regulatory requirements, market demand, cultural fit
- Provide 3-5 items for influencers and content_ideas
- Return only valid JSON, no markdown.`;

	const result = await model.generateContent(prompt);
	const text = result.response.text().trim();
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("Failed to synthesize research");

	return JSON.parse(jsonMatch[0]) as ResearchOutput;
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
	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

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
