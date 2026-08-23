import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductBrief } from "@/lib/screenplay/types";
import { isMarketRecordVisible } from "@/lib/market/data-visibility";

export type ProductBriefLoadResult =
	| { ok: true; productId: string; brief: ProductBrief }
	| { ok: false; status: 400 | 404 | 500; error: string };

type ProductRow = Record<string, unknown>;
type ResearchRow = Record<string, unknown> | null | undefined;
type DiscoveredProductRow = Record<string, unknown> | null | undefined;

interface BuildRowsInput {
	product: ProductRow;
	research?: ResearchRow;
	discoveredProduct?: DiscoveredProductRow;
}

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((item) => text(item))
			.filter(Boolean)
			.slice(0, 12);
	}
	const single = text(value);
	return single ? [single] : [];
}

function compactLines(lines: Array<string | false | null | undefined>): string {
	return lines
		.map((line) => (typeof line === "string" ? line.trim() : ""))
		.filter(Boolean)
		.join("\n\n");
}

function cPackageSummary(row: DiscoveredProductRow): string {
	const cPackage = asRecord(row?.c_package);
	if (Object.keys(cPackage).length === 0) return "";

	const lines = [
		text(cPackage.manufacturer) && `メーカー/製造元: ${text(cPackage.manufacturer)}`,
		text(cPackage.supplier) && `供給元: ${text(cPackage.supplier)}`,
		text(cPackage.wholesale_estimate) && `卸価格目安: ${text(cPackage.wholesale_estimate)}`,
		text(cPackage.moq) && `MOQ: ${text(cPackage.moq)}`,
		text(cPackage.lead_time) && `リードタイム: ${text(cPackage.lead_time)}`,
		text(cPackage.tv_script) && `放送訴求: ${text(cPackage.tv_script)}`,
		text(cPackage.sns_trend) && `SNS傾向: ${text(cPackage.sns_trend)}`,
	];
	return compactLines(lines);
}

// ── Research-field serializers ───────────────────────────────────────────────
// The Gemini research schema (lib/gemini.ts ResearchOutput) stores these as
// OBJECTS / object-arrays, not strings. The brief is a flat string contract, so
// each needs a dedicated serializer — a plain text()/stringList() yields "" and
// silently drops the richest broadcast-relevant data (scripts, pricing, marketing).

/** broadcast_scripts: { sec30, sec60, min5 } → labelled multi-line block. */
function formatBroadcastScripts(value: unknown): string {
	const o = asRecord(value);
	const lines = [
		text(o.sec30) && `【30秒】${text(o.sec30)}`,
		text(o.sec60) && `【60秒】${text(o.sec60)}`,
		text(o.min5) && `【5分】${text(o.min5)}`,
	];
	return lines.filter((l): l is string => Boolean(l)).join("\n");
}

/** marketing_strategy: [{ strategy_name, type, ... }] → "name（type）" items. */
function formatMarketingStrategy(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			const o = asRecord(item);
			const name = text(o.strategy_name);
			if (!name) return "";
			const type = text(o.type);
			return type ? `${name}（${type}）` : name;
		})
		.filter(Boolean)
		.slice(0, 5);
}

/** pricing_strategy: { channel_pricing[], bep_analysis } → channel prices + BEP. */
function formatPricingStrategy(value: unknown): string {
	const o = asRecord(value);
	const lines: string[] = [];
	const channelPricing = o.channel_pricing;
	if (Array.isArray(channelPricing)) {
		for (const item of channelPricing.slice(0, 4)) {
			const r = asRecord(item);
			const channel = text(r.channel);
			const price = text(r.recommended_price);
			if (!channel || !price) continue;
			const margin = text(r.estimated_margin_pct);
			lines.push(`  ${channel}: ${price}${margin ? `（粗利${margin}%）` : ""}`);
		}
	}
	const summary = text(asRecord(o.bep_analysis).summary);
	if (summary) lines.push(`  損益分岐: ${summary}`);
	return lines.length > 0 ? `チャネル別推奨価格:\n${lines.join("\n")}` : "";
}

export function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}

export function buildProductBriefFromRows({
	product,
	research,
	discoveredProduct,
}: BuildRowsInput): ProductBrief {
	const rawResearch = asRecord(asRecord(research?.raw_json).research);
	const researchView = { ...rawResearch, ...asRecord(research) };
	const demographics = asRecord(researchView.demographics);

	const name = text(product.name) || "Untitled product";
	const category = text(product.category) || text(researchView.category);
	const productFeatures = stringList(product.features);
	const marketing = formatMarketingStrategy(researchView.marketing_strategy);
	const broadcastScripts = formatBroadcastScripts(researchView.broadcast_scripts);
	const pricingStrategy = formatPricingStrategy(researchView.pricing_strategy);
	const cPackage = cPackageSummary(discoveredProduct);

	const description = compactLines([
		text(product.description),
		productFeatures.length > 0 && `特徴:\n- ${productFeatures.join("\n- ")}`,
		text(product.target_market) && `登録ターゲット: ${text(product.target_market)}`,
	]);

	// AI research and enrichment outputs are useful planning signals, but they
	// are not verified product facts. Keep them in notes so prompt.ts can apply
	// them to structure without turning them into broadcast claims.
	const notes = compactLines([
		text(researchView.marketability_description) &&
			`市場性仮説: ${text(researchView.marketability_description)}`,
		text(researchView.market_size) && `市場規模仮説: ${text(researchView.market_size)}`,
		text(demographics.primary) && `主要顧客: ${text(demographics.primary)}`,
		marketing.length > 0 && `販売施策:\n- ${marketing.join("\n- ")}`,
		broadcastScripts && `放送訴求案:\n${broadcastScripts}`,
		text(product.price_range) && `商品価格帯: ${text(product.price_range)}`,
		text(researchView.recommended_price_range) &&
			`推奨価格帯: ${text(researchView.recommended_price_range)}`,
		text(researchView.recommended_sales_timing) &&
			`推奨販売時期: ${text(researchView.recommended_sales_timing)}`,
		pricingStrategy,
		text(researchView.risk_analysis) && `注意点: ${text(researchView.risk_analysis)}`,
		cPackage && `Cパッケージ:\n${cPackage}`,
	]);

	return {
		name: name.slice(0, 200),
		category: category ? category.slice(0, 200) : undefined,
		description: (description || text(product.description) || name).slice(0, 16_000),
		notes: notes ? notes.slice(0, 4000) : undefined,
	};
}

export async function loadProductBriefForScreenplay(
	sb: SupabaseClient,
	productId: string,
): Promise<ProductBriefLoadResult> {
	const trimmedId = productId.trim();
	if (!isUuid(trimmedId)) {
		return { ok: false, status: 400, error: "productId の形式が正しくありません" };
	}

	const { data: product, error: productError } = await sb
		.from("products")
		.select(
			"id, name, description, category, price_range, target_market, features, discovered_product_id",
		)
		.eq("id", trimmedId)
		.maybeSingle();

	if (productError) {
		console.error("[screenplays] product lookup failed:", productError);
		return { ok: false, status: 500, error: "商品情報の取得に失敗しました" };
	}
	if (!product) {
		return { ok: false, status: 404, error: "商品が見つかりません" };
	}
	if (!isMarketRecordVisible(product)) {
		return { ok: false, status: 404, error: "商品が見つかりません" };
	}

	const { data: research, error: researchError } = await sb
		.from("research_results")
		.select("*")
		.eq("product_id", trimmedId)
		.maybeSingle();
	if (researchError) {
		console.warn("[screenplays] research lookup failed:", researchError.message);
	}

	let discoveredProduct: DiscoveredProductRow = null;
	const discoveredProductId = text((product as ProductRow).discovered_product_id);
	if (discoveredProductId) {
		const { data, error } = await sb
			.from("discovered_products")
			.select("c_package")
			.eq("id", discoveredProductId)
			.maybeSingle();
		if (error) {
			console.warn("[screenplays] discovered product lookup failed:", error.message);
		} else {
			discoveredProduct = data as DiscoveredProductRow;
		}
	}

	return {
		ok: true,
		productId: trimmedId,
		brief: buildProductBriefFromRows({
			product: product as ProductRow,
			research: research as ResearchRow,
			discoveredProduct,
		}),
	};
}
