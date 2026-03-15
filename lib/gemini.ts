import { GoogleGenerativeAI } from '@google/generative-ai';

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
  market_size?: string;
  competitors?: Array<{ name: string; price_range: string }>;
  usp_points?: string[];
  risk_analysis?: string;
  recommended_sales_timing?: string;
  expected_roi?: string;
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
    margin_analysis?: string;
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
}

export async function extractProductInfo(
  fileBase64: string,
  mimeType: string,
  fileName: string,
  locale: string = 'en'
): Promise<ProductInfo> {
  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const isJa = locale === 'ja';

  const prompt = isJa
    ? `あなたはホームショッピングチャンネルの商品アナリストです。このファイルを分析し、商品情報をすべて抽出してください。

必ず以下のJSONフィールドを返してください（値はすべて日本語で記述）：
- name: 商品名（文字列）
- description: 詳細な商品説明（文字列、日本語）
- features: 主な商品特徴（文字列の配列、日本語）
- category: 商品カテゴリ（文字列、日本語）
- price_range: 価格帯（記載がある場合、文字列）
- target_market: ターゲット市場（記載がある場合、文字列、日本語）

ファイル名: ${fileName}

有効なJSONのみを返してください（マークダウン不可）。すべての値は日本語で記述してください。`
    : `You are a product analyst for home shopping channels. Analyze this file and extract all product information.

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
  if (!jsonMatch) throw new Error('Failed to extract product info from file');

  return JSON.parse(jsonMatch[0]) as ProductInfo;
}

export async function synthesizeResearch(
  productInfo: ProductInfo,
  searchResults: Record<string, string>,
  locale: string = 'en'
): Promise<ResearchOutput> {
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-pro-preview' });

  const isJa = locale === 'ja';

  const prompt = isJa
    ? `あなたは日本のホームショッピング市場の専門アナリストです。以下の商品情報とウェブ調査結果を基に、総合的なリサーチレポートを生成してください。

【重要】すべての出力は必ず日本語で記述してください。英語は一切使用しないでください。
すべての分析結果を日本語で出力してください。

商品情報:
${JSON.stringify(productInfo, null, 2)}

ウェブ調査結果:
${Object.entries(searchResults)
  .map(([key, val]) => `## ${key}\n${val}`)
  .join('\n\n')}

以下の正確なフィールドでJSONレスポンスを生成してください（すべての値は日本語）:
{
  "marketability_score": <数値 0-100>,
  "marketability_description": "<日本市場における市場ポテンシャルの詳細説明（3〜4文）>",
  "market_size": "<具体的な市場規模（金額・数値を含む）例：「日本の通販市場は2024年に約10兆円規模」>",
  "competitors": [
    {
      "name": "<競合ブランド名>",
      "price_range": "<価格帯、例：3,000〜8,000円>"
    }
  ],
  "usp_points": [
    "<ホームショッピングで通じるUSP（独自の強み）その1>",
    "<USP その2>",
    "<USP その3>",
    "<USP その4>",
    "<USP その5>"
  ],
  "risk_analysis": "<リスク分析：参入障壁、注意事項、潜在的リスクを詳述>",
  "recommended_sales_timing": "<推奨販売時期：月別の売上予測と最適な販売タイミングを具体的に説明>",
  "expected_roi": "<予想ROI：推定原価・販売価格・マージン率を含む収益性分析>",
  "demographics": {
    "age_group": "<例：40〜60代を中心とした主婦層>",
    "gender": "<例：女性が主体（約70%）>",
    "interests": ["<関心事1>", "<関心事2>", "<関心事3>"],
    "income_level": "<例：中〜高所得層（年収400〜700万円）>"
  },
  "seasonality": {
    "jan": <0-100>, "feb": <0-100>, "mar": <0-100>, "apr": <0-100>,
    "may": <0-100>, "jun": <0-100>, "jul": <0-100>, "aug": <0-100>,
    "sep": <0-100>, "oct": <0-100>, "nov": <0-100>, "dec": <0-100>
  },
  "cogs_estimate": {
    "items": [
      {
        "supplier": "<サプライヤー名（例：中国仕入れ先、国内問屋）>",
        "estimated_cost": "<推定仕入れコスト（例：500〜800円/個）>",
        "moq": "<最小発注数量>",
        "link": "<任意URL>"
      }
    ],
    "summary": "<原価分析の要約（日本語）>",
    "margin_analysis": "<マージン分析：仕入れ価格・販売価格・粗利率の試算>"
  },
  "influencers": [
    {
      "name": "<インフルエンサー名またはチャンネル名（具体的な名前）>",
      "platform": "<YouTube / Instagram / TikTok>",
      "followers": "<例：50万〜100万人>",
      "match_reason": "<この商品との相性が良い理由（日本語）>",
      "profile_url": "<任意URL>"
    }
  ],
  "content_ideas": [
    {
      "title": "<コンテンツタイトル（日本語）>",
      "description": "<コンテンツの詳細説明と成功のポイント（日本語）>",
      "format": "<動画 / ブログ / SNS投稿 / ライブ配信 等>"
    }
  ],
  "competitor_analysis": [
    {
      "name": "<競合商品名>",
      "price": "<価格、例：¥3,980>",
      "platform": "<例：Amazon Japan / 楽天 / QVC Japan>",
      "key_difference": "<差別化ポイント>"
    }
  ],
  "recommended_price_range": "<例：¥3,980-5,980>",
  "broadcast_scripts": {
    "sec30": "<30秒ホームショッピング放送台本（日本語、自然で説得力のある文体）>",
    "sec60": "<60秒ホームショッピング放送台本（日本語）>",
    "min5": "<5分間ホームショッピング放送台本（日本語）>"
  },
  "japan_export_fit_score": <数値 0-100、韓国→日本ホームショッピング輸出適合性>
}

インフルエンサーは3〜5件、コンテンツアイデアは5件以上、競合ブランドは3〜5件、competitor_analysisは3件以上提供してください。
broadcast_scriptsは実際に放送で読み上げられる台本（自然で説得力のある日本語）で記述してください。
有効なJSONのみを返してください（マークダウン不可）。すべての値は必ず日本語で記述してください。`
    : `You are a home shopping marketing research analyst specializing in Japan market entry. Based on the product information and web search results, generate a comprehensive research report.

Product Information:
${JSON.stringify(productInfo, null, 2)}

Web Search Results:
${Object.entries(searchResults)
  .map(([key, val]) => `## ${key}\n${val}`)
  .join('\n\n')}

Generate a JSON response with these exact fields:
{
  "marketability_score": <number 0-100>,
  "marketability_description": "<detailed explanation of market potential in 3-4 sentences>",
  "market_size": "<specific market size with figures, e.g. 'US home shopping market valued at $12B in 2024'>",
  "competitors": [
    {
      "name": "<competitor brand name>",
      "price_range": "<price range, e.g. $20-50>"
    }
  ],
  "usp_points": [
    "<unique selling point 1>",
    "<USP 2>",
    "<USP 3>",
    "<USP 4>",
    "<USP 5>"
  ],
  "risk_analysis": "<risk analysis: entry barriers, caveats, potential risks>",
  "recommended_sales_timing": "<recommended sales timing by month, peak seasons>",
  "expected_roi": "<expected ROI: estimated cost, selling price, margin rate>",
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
    "summary": "<brief summary of COGS analysis>",
    "margin_analysis": "<margin analysis: cost vs. selling price vs. gross margin %>"
  },
  "influencers": [
    {
      "name": "<influencer name or channel name>",
      "platform": "<YouTube/Instagram/TikTok>",
      "followers": "<e.g., '500K-1M'>",
      "match_reason": "<why this influencer fits the product>",
      "profile_url": "<optional URL>"
    }
  ],
  "content_ideas": [
    {
      "title": "<content title>",
      "description": "<content description and success factors>",
      "format": "<Video/Blog/Social Post/Live Stream/etc>"
    }
  ],
  "competitor_analysis": [
    {
      "name": "<competitor product name>",
      "price": "<price, e.g. '¥3,980'>",
      "platform": "<e.g. 'Amazon Japan / 楽天 / QVC Japan'>",
      "key_difference": "<what differentiates this competitor>"
    }
  ],
  "recommended_price_range": "<e.g. '¥3,980-5,980'>",
  "broadcast_scripts": {
    "sec30": "<30-second home shopping broadcast script in Japanese>",
    "sec60": "<60-second home shopping broadcast script in Japanese>",
    "min5": "<5-minute home shopping broadcast script in Japanese>"
  },
  "japan_export_fit_score": <number 0-100, how well this Korean product fits the Japan home shopping market>
}

Provide 3-5 competitors, 3-5 influencers, 5+ content_ideas, and 3+ competitor_analysis items.
For competitor_analysis, find at least 3 competing products on Japanese e-commerce platforms.
For recommended_price_range, base it on the Japan home shopping market pricing norms.
For broadcast_scripts, write actual scripts that can be read on air (in Japanese, natural and persuasive).
For japan_export_fit_score, evaluate Korea→Japan home shopping export suitability (0-100).
Return only valid JSON, no markdown.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to synthesize research');

  return JSON.parse(jsonMatch[0]) as ResearchOutput;
}
