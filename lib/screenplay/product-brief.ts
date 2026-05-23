import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductBrief } from "@/lib/screenplay/types";

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
	const uspPoints = stringList(researchView.usp_points);
	const marketing = stringList(researchView.marketing_strategy);
	const broadcastScripts = stringList(researchView.broadcast_scripts);
	const cPackage = cPackageSummary(discoveredProduct);

	const description = compactLines([
		text(product.description),
		text(researchView.marketability_description) &&
			`市場性: ${text(researchView.marketability_description)}`,
		productFeatures.length > 0 && `特徴:\n- ${productFeatures.join("\n- ")}`,
		uspPoints.length > 0 && `USP:\n- ${uspPoints.join("\n- ")}`,
		text(researchView.market_size) && `市場規模: ${text(researchView.market_size)}`,
		text(product.target_market) && `想定ターゲット: ${text(product.target_market)}`,
		text(demographics.primary) && `主要顧客: ${text(demographics.primary)}`,
		marketing.length > 0 && `販売施策:\n- ${marketing.join("\n- ")}`,
		broadcastScripts.length > 0 && `放送訴求案:\n- ${broadcastScripts.join("\n- ")}`,
	]);

	const notes = compactLines([
		text(product.price_range) && `商品価格帯: ${text(product.price_range)}`,
		text(researchView.recommended_price_range) &&
			`推奨価格帯: ${text(researchView.recommended_price_range)}`,
		text(researchView.recommended_sales_timing) &&
			`推奨販売時期: ${text(researchView.recommended_sales_timing)}`,
		text(researchView.pricing_strategy) && `価格戦略: ${text(researchView.pricing_strategy)}`,
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
