import { GoogleGenerativeAI } from "@google/generative-ai";

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
	const model = genAI.getGenerativeModel({ model: modelName });

	const prompt = `You are a home shopping marketing research analyst specializing in Japan market expansion. Based on the product information and web search results, generate a comprehensive research report.

IMPORTANT: ALL text fields in the JSON response MUST be written in Japanese (日本語). This includes marketability_description, demographics fields, influencer match_reason, content_ideas titles and descriptions, competitor key_difference, broadcast_scripts, recommended_price_range descriptions, and any other text. Only product names, URLs, and numeric values may remain in their original language.

Product Information:
${JSON.stringify(productInfo, null, 2)}

Web Search Results:
${Object.entries(searchResults)
		.map(([key, val]) => `## ${key}\n${val}`)
		.join("\n\n")}

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
    "sec30": "<30-second home shopping broadcast script in Korean>",
    "sec60": "<60-second home shopping broadcast script in Korean>",
    "min5": "<5-minute detailed home shopping broadcast script in Korean with host cues>"
  },
  "japan_export_fit_score": <number 0-100, how well this product fits Japan market>
}

IMPORTANT:
- Provide exactly 3 competitor products in competitor_analysis
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
