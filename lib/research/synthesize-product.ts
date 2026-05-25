import type { SupabaseClient } from "@supabase/supabase-js";
import { runProductResearch } from "@/lib/brave";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import { synthesizeResearch } from "@/lib/gemini";
import type { ProductInfo, ResearchOutput } from "@/lib/gemini";
import { getServiceClient } from "@/lib/supabase";
import {
	formatBroadcastContextPrompt,
	loadBroadcastContext,
} from "@/lib/research/competitor-context";

export type ResearchProductRow = {
	name?: string | null;
	description?: string | null;
	features?: unknown;
	category?: string | null;
	price_range?: string | null;
	target_market?: string | null;
};

export type ResearchResultInsert = {
	product_id: string;
	marketability_score: number;
	marketability_description: string;
	demographics: ResearchOutput["demographics"];
	seasonality: ResearchOutput["seasonality"];
	cogs_estimate: ResearchOutput["cogs_estimate"];
	influencers: ResearchOutput["influencers"];
	content_ideas: ResearchOutput["content_ideas"];
	competitor_analysis: ResearchOutput["competitor_analysis"];
	recommended_price_range: string;
	broadcast_scripts: ResearchOutput["broadcast_scripts"];
	japan_export_fit_score: number;
	distribution_channels: ResearchOutput["distribution_channels"];
	pricing_strategy: ResearchOutput["pricing_strategy"];
	marketing_strategy: ResearchOutput["marketing_strategy"];
	korea_market_fit: ResearchOutput["korea_market_fit"] | null;
	live_commerce: ResearchOutput["live_commerce"];
	raw_json: {
		product_info: ProductInfo;
		search_results: Record<string, string>;
	};
};

export interface ProductResearchSynthesisResult {
	productId: string;
	success: true;
}

export class ProductResearchSynthesisError extends Error {
	constructor(
		public readonly status: 404 | 500,
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "ProductResearchSynthesisError";
	}
}

function optionalString(value: string | null | undefined): string | undefined {
	return value && value.trim().length > 0 ? value : undefined;
}

function normalizeFeatures(features: unknown): string[] {
	if (!Array.isArray(features)) return [];
	return features
		.filter((feature): feature is string => typeof feature === "string")
		.map((feature) => feature.trim())
		.filter(Boolean);
}

export function buildProductInfoFromProductRow(
	product: ResearchProductRow,
): ProductInfo {
	return {
		name: optionalString(product.name) ?? "Unknown Product",
		description: optionalString(product.description) ?? "",
		features: normalizeFeatures(product.features),
		category: optionalString(product.category) ?? "General",
		price_range: optionalString(product.price_range),
		target_market: optionalString(product.target_market),
	};
}

export function buildResearchResultInsert(
	productId: string,
	productInfo: ProductInfo,
	searchResults: Record<string, string>,
	research: ResearchOutput,
): ResearchResultInsert {
	// korea_market_fit.fit_score が非数値だと generated column キャストが失敗するので整数に正規化
	const koreaFit = research.korea_market_fit;
	if (koreaFit && typeof koreaFit === "object") {
		const raw = (koreaFit as { fit_score?: unknown }).fit_score;
		const num = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
		(koreaFit as { fit_score?: number | null }).fit_score = Number.isFinite(num) ? num : null;
	}

	return {
		product_id: productId,
		marketability_score: research.marketability_score,
		marketability_description: research.marketability_description,
		demographics: research.demographics,
		seasonality: research.seasonality,
		cogs_estimate: research.cogs_estimate,
		influencers: research.influencers,
		content_ideas: research.content_ideas,
		competitor_analysis: research.competitor_analysis,
		recommended_price_range: research.recommended_price_range,
		broadcast_scripts: research.broadcast_scripts,
		japan_export_fit_score: research.japan_export_fit_score,
		distribution_channels: research.distribution_channels,
		pricing_strategy: research.pricing_strategy,
		marketing_strategy: research.marketing_strategy,
		korea_market_fit: koreaFit ?? null,
		live_commerce: research.live_commerce,
		// raw_json はデバッグ用 — research 本体はカラムに移行済みのため重複保存しない
		raw_json: {
			product_info: productInfo,
			search_results: searchResults,
		},
	};
}

async function markProductStatus(
	sb: SupabaseClient,
	productId: string,
	status: "analyzing" | "completed" | "failed",
): Promise<void> {
	const { error } = await sb.from("products").update({ status }).eq("id", productId);
	if (error) throw error;
}

export async function synthesizeProductResearch(
	productId: string,
	sb: SupabaseClient = getServiceClient(),
): Promise<ProductResearchSynthesisResult> {
	const { data: product, error: productError } = await sb
		.from("products")
		.select("*")
		.eq("id", productId)
		.maybeSingle();

	if (productError) {
		throw new ProductResearchSynthesisError(500, "Product load failed", productError);
	}
	if (!product) {
		throw new ProductResearchSynthesisError(404, "Product not found");
	}

	try {
		const productInfo = buildProductInfoFromProductRow(product);

		await markProductStatus(sb, productId, "analyzing");

		console.log(`[${productId}] Running web research (incl. Japan market)...`);
		const searchResults = await runProductResearch(
			productInfo.name,
			productInfo.category,
		);

		console.log(
			`[${productId}] Loading broadcast context for category: ${productInfo.category}`,
		);
		const broadcastContext = await loadBroadcastContext(productInfo.category);
		const broadcastContextPrompt = formatBroadcastContextPrompt(broadcastContext);

		console.log(`[${productId}] Synthesizing research with ${GEMINI_FLASH}...`);
		const research = await synthesizeResearch(
			productInfo,
			searchResults,
			broadcastContextPrompt,
		);

		const { error: upsertErr } = await sb
			.from("research_results")
			.upsert(buildResearchResultInsert(productId, productInfo, searchResults, research), {
				onConflict: "product_id",
			});
		if (upsertErr) throw new ProductResearchSynthesisError(500, upsertErr.message);

		await markProductStatus(sb, productId, "completed");
		console.log(`[${productId}] Synthesis completed`);
		return { productId, success: true };
	} catch (error) {
		console.error(`[${productId}] Synthesis failed:`, error);
		try {
			await markProductStatus(sb, productId, "failed");
		} catch (statusError) {
			console.error(`[${productId}] Failed to mark synthesis failure:`, statusError);
		}
		throw new ProductResearchSynthesisError(500, "Synthesis failed", error);
	}
}

export const __test = {
	normalizeFeatures,
	optionalString,
};
