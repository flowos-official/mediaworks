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
}

export async function extractProductInfo(
  fileBase64: string,
  mimeType: string,
  fileName: string
): Promise<ProductInfo> {
  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

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
  if (!jsonMatch) throw new Error('Failed to extract product info from file');

  return JSON.parse(jsonMatch[0]) as ProductInfo;
}

export async function synthesizeResearch(
  productInfo: ProductInfo,
  searchResults: Record<string, string>
): Promise<ResearchOutput> {
  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const prompt = `You are a home shopping marketing research analyst. Based on the product information and web search results, generate a comprehensive research report.

Product Information:
${JSON.stringify(productInfo, null, 2)}

Web Search Results:
${Object.entries(searchResults)
  .map(([key, val]) => `## ${key}\n${val}`)
  .join('\n\n')}

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
  ]
}

Provide 3-5 items for influencers and content_ideas. Return only valid JSON, no markdown.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to synthesize research');

  return JSON.parse(jsonMatch[0]) as ResearchOutput;
}
