/**
 * Enrichment agent — Gemini 3-Flash with function calling.
 * Given a discovered product, orchestrates tools to build a C package:
 *  - manufacturer identification
 *  - wholesale estimate
 *  - MOQ hint
 *  - TV script
 *  - SNS trend signal
 *
 * Ref: spec §5 Stage 2.
 *
 * Contract: throws on unrecoverable failure; returns partial=true if
 * timeout hit before completion. Caller handles DB persistence.
 */

import {
	SchemaType,
	GoogleGenerativeAI,
	type FunctionCall,
	type FunctionDeclaration,
} from "@google/generative-ai";
import { braveSearchItems } from "@/lib/brave";
import { fetchUrlMeta } from "./tools/fetch-meta";
import { fetchRakutenPage } from "./tools/rakuten-page";
import { generateTvScriptDraft } from "./tools/tv-script";
import { estimateWholesale } from "./wholesale-rules";
import type {
	CPackage,
	Confidence,
	ManufacturerInfo,
	WholesaleEstimate,
} from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const MAX_TOOL_CALLS = 8;
const TIMEOUT_MS = 55_000;

export interface EnrichInput {
	productUrl: string;
	name: string;
	priceJpy: number | null;
	category: string | null;
	sellerName: string | null;
	reviewCount: number | null;
	reviewAvg: number | null;
	tvFitReason: string | null;
}

const TOOL_DECLARATIONS: Array<{
	name: string;
	description: string;
	parameters: {
		type: SchemaType;
		properties: Record<string, { type: SchemaType; description: string }>;
		required: string[];
	};
}> = [
	{
		name: "fetch_rakuten_page",
		description:
			"Fetches a Rakuten product/shop page and extracts seller info (shop name, company, address, manufacturer hint).",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				url: {
					type: SchemaType.STRING,
					description: "Rakuten item URL",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "search_brave",
		description:
			"Web search (Brave) for supplementary info — manufacturer official site, reviews, SNS mentions.",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				query: {
					type: SchemaType.STRING,
					description: "Search query (Japanese or English)",
				},
				count: {
					type: SchemaType.NUMBER,
					description: "Number of results (1-10, default 5)",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "fetch_url_meta",
		description:
			"Fetch a URL and extract page title, description, and contact info (emails, phones).",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				url: {
					type: SchemaType.STRING,
					description: "HTTP(S) URL",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "estimate_wholesale",
		description:
			"Estimate wholesale cost from retail price using industry baseline + MediaWorks historical data blend.",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				retail_jpy: {
					type: SchemaType.NUMBER,
					description: "Retail price in JPY",
				},
				category: {
					type: SchemaType.STRING,
					description: "Product category (e.g. 美容家電, 健康食品)",
				},
			},
			required: ["retail_jpy", "category"],
		},
	},
];

const SYSTEM_PROMPT = `あなたは日本のテレビ通販ソーシング会社のアシスタントエージェントです。
発掘された商品1件について、以下のC パッケージ情報を収集してください。

【収集項目】
1. manufacturer: 製造元の特定 (名称, 公式サイト, 住所, 連絡ヒント, 信頼度)
   - Rakuten販売者が製造元か判定 (会社名に「メーカー」「製造」を含むか、公式サイト有無など)
   - 販売者 ≠ 製造元の場合は search_brave + fetch_url_meta で追跡
2. wholesale_estimate: 小売→卸売 推定 (estimate_wholesale ツール使用)
3. moq_hint: MOQ情報 (公式サイトやB2B情報に明記があれば)
4. sns_trend: TikTok / Instagram / X 等でのトレンド信号 (search_brave で確認)

【制約】
- 最大ツール呼び出し: 8回
- 連絡先を捏造しないこと。不明な場合は null, confidence='low'
- 自然言語出力はすべて日本語

【最終出力】
ツール実行を終えたら、次のJSON形式で結果を返してください (JSONのみ、前置き/後書きなし):

{
  "manufacturer": {
    "name": "...or null",
    "is_seller_same_as_manufacturer": true,
    "official_site": "...or null",
    "address": "...or null",
    "contact_hints": ["email", "phone"],
    "confidence": "high|medium|low"
  },
  "moq_hint": "...or null",
  "sns_trend": {
    "signal_strength": "high|medium|low|none",
    "sources": ["tiktok", "instagram"]
  }
}

※ wholesale_estimate と tv_script_draft はエージェント外で自動生成されるため、このJSON出力には含めないこと。`;

interface ToolResult {
	name: string;
	response: Record<string, unknown>;
}

async function executeTool(call: FunctionCall): Promise<ToolResult> {
	try {
		switch (call.name) {
			case "fetch_rakuten_page": {
				const url = (call.args as { url?: string }).url ?? "";
				const info = await fetchRakutenPage(url);
				return { name: call.name, response: info as unknown as Record<string, unknown> };
			}
			case "search_brave": {
				const { query, count } = call.args as { query?: string; count?: number };
				const results = await braveSearchItems(query ?? "", count ?? 5);
				return { name: call.name, response: { results } };
			}
			case "fetch_url_meta": {
				const { url } = call.args as { url?: string };
				const meta = await fetchUrlMeta(url ?? "");
				return { name: call.name, response: meta as unknown as Record<string, unknown> };
			}
			case "estimate_wholesale": {
				const { retail_jpy, category } = call.args as {
					retail_jpy?: number;
					category?: string;
				};
				const est = await estimateWholesale(retail_jpy ?? 0, category ?? null);
				return { name: call.name, response: est as unknown as Record<string, unknown> };
			}
			default:
				return { name: call.name, response: { error: "unknown tool" } };
		}
	} catch (err) {
		return {
			name: call.name,
			response: {
				error: err instanceof Error ? err.message : String(err),
			},
		};
	}
}

function emptyCPackage(reason: string): CPackage {
	return {
		manufacturer: {
			name: null,
			is_seller_same_as_manufacturer: false,
			official_site: null,
			address: null,
			contact_hints: [],
			confidence: "low",
		},
		wholesale_estimate: {
			retail_jpy: 0,
			estimated_cost_jpy: null,
			estimated_margin_rate: null,
			method: "baseline",
			sample_size: 0,
			confidence: "low",
		},
		moq_hint: null,
		tv_script_draft: "(スクリプト生成失敗)",
		sns_trend: { signal_strength: "none", sources: [] },
		enriched_at: new Date().toISOString(),
		tool_calls_used: 0,
		partial: true,
		error: reason,
	};
}

interface AgentCoreResult {
	manufacturer: ManufacturerInfo;
	moq_hint: string | null;
	sns_trend: { signal_strength: "high" | "medium" | "low" | "none"; sources: string[] };
	tool_calls_used: number;
}

async function runAgentCore(
	input: EnrichInput,
	deadline: number,
): Promise<AgentCoreResult> {
	const model = genAI.getGenerativeModel({
		model: MODEL_ID,
		tools: [{ functionDeclarations: TOOL_DECLARATIONS as unknown as FunctionDeclaration[] }],
	});
	const chat = model.startChat({
		systemInstruction: { role: "system", parts: [{ text: SYSTEM_PROMPT }] },
	});

	const initialPrompt = `商品情報:
- 商品名: ${input.name}
- URL: ${input.productUrl}
${input.priceJpy ? `- 価格: ¥${input.priceJpy}` : ""}
${input.category ? `- カテゴリ: ${input.category}` : ""}
${input.sellerName ? `- 販売者: ${input.sellerName}` : ""}
${input.reviewAvg ? `- レビュー: ★${input.reviewAvg} (${input.reviewCount ?? 0})` : ""}

上記商品のC パッケージ情報を収集してください。まず fetch_rakuten_page ツールで販売者情報を確認することから始めてください。`;

	let result = await chat.sendMessage(initialPrompt);
	let toolCalls = 0;

	while (toolCalls < MAX_TOOL_CALLS && Date.now() < deadline) {
		const calls = result.response.functionCalls();
		if (!calls || calls.length === 0) break;

		const responses = await Promise.all(calls.map(executeTool));
		toolCalls += calls.length;

		result = await chat.sendMessage(
			responses.map((r) => ({
				functionResponse: { name: r.name, response: r.response },
			})),
		);
	}

	// Final text should be JSON
	const text = result.response.text();
	const match = text.match(/\{[\s\S]+\}/);
	if (!match) {
		throw new Error(`no final JSON in agent response: ${text.slice(0, 200)}`);
	}
	const parsed = JSON.parse(match[0]) as {
		manufacturer?: Partial<ManufacturerInfo>;
		moq_hint?: string | null;
		sns_trend?: { signal_strength?: string; sources?: string[] };
	};

	return {
		manufacturer: {
			name: parsed.manufacturer?.name ?? null,
			is_seller_same_as_manufacturer:
				parsed.manufacturer?.is_seller_same_as_manufacturer ?? false,
			official_site: parsed.manufacturer?.official_site ?? null,
			address: parsed.manufacturer?.address ?? null,
			contact_hints: parsed.manufacturer?.contact_hints ?? [],
			confidence: (parsed.manufacturer?.confidence as Confidence) ?? "low",
		},
		moq_hint: parsed.moq_hint ?? null,
		sns_trend: {
			signal_strength:
				(parsed.sns_trend?.signal_strength as
					| "high"
					| "medium"
					| "low"
					| "none") ?? "none",
			sources: parsed.sns_trend?.sources ?? [],
		},
		tool_calls_used: toolCalls,
	};
}

/**
 * Main entry: returns a complete C package (or partial on timeout/error).
 */
export async function enrichProduct(input: EnrichInput): Promise<CPackage> {
	const start = Date.now();
	const deadline = start + TIMEOUT_MS;

	let wholesale: WholesaleEstimate = {
		retail_jpy: input.priceJpy ?? 0,
		estimated_cost_jpy: null,
		estimated_margin_rate: null,
		method: "baseline",
		sample_size: 0,
		confidence: "low",
	};
	let tvScript = "(スクリプト生成失敗)";

	// Run wholesale + TV script in parallel with the agent to save time
	const [coreResult, wholesaleResult, scriptResult] = await Promise.allSettled([
		runAgentCore(input, deadline),
		input.priceJpy
			? estimateWholesale(input.priceJpy, input.category)
			: Promise.resolve(wholesale),
		generateTvScriptDraft({
			productName: input.name,
			priceJpy: input.priceJpy,
			reviewCount: input.reviewCount,
			reviewAvg: input.reviewAvg,
			tvFitReason: input.tvFitReason,
		}),
	]);

	if (wholesaleResult.status === "fulfilled") wholesale = wholesaleResult.value;
	if (scriptResult.status === "fulfilled") tvScript = scriptResult.value;

	if (coreResult.status !== "fulfilled") {
		const err =
			coreResult.reason instanceof Error
				? coreResult.reason.message
				: String(coreResult.reason);
		const partial = emptyCPackage(err);
		partial.wholesale_estimate = wholesale;
		partial.tv_script_draft = tvScript;
		return partial;
	}

	const core = coreResult.value;
	return {
		manufacturer: core.manufacturer,
		wholesale_estimate: wholesale,
		moq_hint: core.moq_hint,
		tv_script_draft: tvScript,
		sns_trend: core.sns_trend,
		enriched_at: new Date().toISOString(),
		tool_calls_used: core.tool_calls_used,
		partial: Date.now() > deadline,
	};
}
