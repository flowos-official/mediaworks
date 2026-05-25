import type { SupabaseClient } from "@supabase/supabase-js";
import type { CPackage } from "@/lib/discovery/types";

export interface DiscoveredProductForPromotion {
	id: string;
	name: string;
	product_url: string;
	thumbnail_url: string | null;
	category: string | null;
	price_jpy: number | null;
	tv_fit_reason: string | null;
	enrichment_status: string;
	c_package: CPackage | null;
}

interface ProductInsertPayload {
	name: string;
	description: string;
	file_url: string;
	file_name: string;
	category: string | null;
	features: string[];
	price_range: string | null;
	target_market: string | null;
	status: "analyzing";
	ingest_source: "discovery_promotion";
	discovered_product_id: string;
}

export interface PromotionResult {
	productId: string;
	alreadyPromoted: boolean;
}

export type PromotionFailureStatus = 404 | 409 | 500;

export class PromotionError extends Error {
	constructor(
		public readonly status: PromotionFailureStatus,
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "PromotionError";
	}
}

export function formatPromotionError(error: unknown): string {
	if (!(error instanceof PromotionError)) {
		return error instanceof Error ? error.message : String(error);
	}
	const details: string[] = [error.message];
	const cause = error.cause as
		| {
				message?: string;
				code?: string;
				details?: string;
				hint?: string;
		  }
		| undefined;
	if (cause?.message) details.push(`cause: ${cause.message}`);
	if (cause?.code) details.push(`code: ${cause.code}`);
	if (cause?.details) details.push(`details: ${cause.details}`);
	if (cause?.hint) details.push(`hint: ${cause.hint}`);
	return details.join("\n");
}

function buildDescriptionFromCPackage(
	cp: CPackage | null,
	fallback: string | null,
): string {
	if (!cp) return fallback ?? "";
	const parts: string[] = [];
	if (cp.tv_script_draft && cp.tv_script_draft.trim().length > 0) {
		parts.push(cp.tv_script_draft.trim());
	}
	const mfgName = cp.manufacturer?.name;
	if (mfgName) parts.push(`製造元: ${mfgName}`);
	if (cp.sns_trend?.signal_strength && cp.sns_trend.signal_strength !== "none") {
		const sourceCount = cp.sns_trend.sources?.length ?? 0;
		parts.push(`SNS シグナル: ${cp.sns_trend.signal_strength} (${sourceCount}件)`);
	}
	return parts.join("\n\n").trim() || fallback || "";
}

function buildFeaturesFromCPackage(cp: CPackage | null): string[] {
	if (!cp) return [];
	const features: string[] = [];
	const mfgName = cp.manufacturer?.name;
	if (mfgName) features.push(`製造元: ${mfgName}`);
	if (cp.moq_hint) features.push(`MOQ: ${cp.moq_hint}`);
	const cost = cp.wholesale_estimate?.estimated_cost_jpy;
	if (cost != null && cost > 0) {
		features.push(`卸値推定: ¥${cost.toLocaleString()}`);
	}
	return features;
}

function formatPriceRange(priceJpy: number | null): string | null {
	if (!priceJpy || priceJpy <= 0) return null;
	return `¥${priceJpy.toLocaleString()}`;
}

function formatDiscoveryFileName(discoveredProductId: string): string {
	return `discovery-${discoveredProductId}.url`;
}

export function buildDiscoveryPromotionInsert(
	dp: DiscoveredProductForPromotion,
): ProductInsertPayload {
	return {
		name: dp.name,
		description: buildDescriptionFromCPackage(dp.c_package, dp.tv_fit_reason),
		file_url: dp.product_url,
		file_name: formatDiscoveryFileName(dp.id),
		category: dp.category,
		features: buildFeaturesFromCPackage(dp.c_package),
		price_range: formatPriceRange(dp.price_jpy),
		target_market: null,
		status: "analyzing",
		ingest_source: "discovery_promotion",
		discovered_product_id: dp.id,
	};
}

export function promotionFeedbackRow(discoveredProductId: string) {
	return {
		discovered_product_id: discoveredProductId,
		action: "deep_dive" as const,
		reason: "promoted_to_research",
	};
}

export async function triggerResearchSynthesis(productId: string): Promise<void> {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		console.error(
			"[promote-to-research] CRON_SECRET not set — synthesize will not start",
		);
		return;
	}
	const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
	const res = await fetch(`${baseUrl}/api/analyze/synthesize`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${cronSecret}`,
		},
		body: JSON.stringify({ productId }),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`synthesis trigger failed (${res.status}): ${body}`);
	}
}

export async function promoteDiscoveredProductToResearch(
	sb: SupabaseClient,
	discoveredProductId: string,
	options: { triggerSynthesis?: boolean } = {},
): Promise<PromotionResult> {
	const { data: dp, error: dpErr } = await sb
		.from("discovered_products")
		.select("id, name, product_url, thumbnail_url, category, price_jpy, tv_fit_reason, c_package, enrichment_status")
		.eq("id", discoveredProductId)
		.maybeSingle();

	if (dpErr) {
		throw new PromotionError(500, "load failed", dpErr);
	}
	if (!dp) {
		throw new PromotionError(404, "discovered product not found");
	}
	const discoveredProduct = {
		...dp,
		c_package: (dp.c_package as CPackage | null) ?? null,
	} as DiscoveredProductForPromotion;
	if (discoveredProduct.enrichment_status !== "completed") {
		throw new PromotionError(409, "c_package not ready, run enrichment first");
	}

	const { data: existing } = await sb
		.from("products")
		.select("id")
		.eq("discovered_product_id", discoveredProductId)
		.maybeSingle();
	if (existing) {
		return { productId: existing.id as string, alreadyPromoted: true };
	}

	const { data: inserted, error: insErr } = await sb
		.from("products")
		.insert(buildDiscoveryPromotionInsert(discoveredProduct))
		.select("id")
		.single();

	if (insErr || !inserted) {
		if (insErr && (insErr as { code?: string }).code === "23505") {
			const { data: raced } = await sb
				.from("products")
				.select("id")
				.eq("discovered_product_id", discoveredProductId)
				.maybeSingle();
			if (raced) {
				return { productId: raced.id as string, alreadyPromoted: true };
			}
		}
		throw new PromotionError(500, "promotion failed", insErr);
	}

	const newProductId = inserted.id as string;
	const { error: fbErr } = await sb
		.from("product_feedback")
		.insert(promotionFeedbackRow(discoveredProductId));
	if (fbErr) {
		console.warn("[promote-to-research] deep_dive feedback insert failed", fbErr);
	}

	if (options.triggerSynthesis) {
		triggerResearchSynthesis(newProductId).catch((err) => {
			console.error(
				`[promote-to-research:${newProductId}] synthesize trigger failed`,
				err,
			);
		});
	}

	return { productId: newProductId, alreadyPromoted: false };
}

export const __test = {
	buildDescriptionFromCPackage,
	buildFeaturesFromCPackage,
	formatDiscoveryFileName,
	formatPriceRange,
};
