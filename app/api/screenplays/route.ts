import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { getServiceClient } from "@/lib/supabase";
import { screenplayWorkflow } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
	const supabase = getServiceClient();
	const { data, error } = await supabase
		.from("screenplays")
		.select("id, title, status, current_version_id, created_at, updated_at, product_id, product_info_snapshot")
		.order("updated_at", { ascending: false })
		.limit(50);
	if (error) return Response.json({ error: error.message }, { status: 500 });
	return Response.json({ screenplays: data ?? [] });
}

interface ProductRow {
	id: string;
	name: string;
	description: string | null;
	category: string | null;
	features: string[] | null;
	target_market: string | null;
	price_range: string | null;
}

function briefFromProduct(p: ProductRow): ProductBrief {
	const lines: string[] = [];
	if (p.description) lines.push(p.description.trim());
	if (Array.isArray(p.features) && p.features.length > 0) {
		lines.push("");
		lines.push("特徴:");
		for (const f of p.features.slice(0, 30)) {
			if (typeof f === "string" && f.trim()) lines.push(`- ${f.trim()}`);
		}
	}
	if (p.target_market) {
		lines.push("");
		lines.push(`想定ターゲット: ${p.target_market.trim()}`);
	}
	if (p.price_range) {
		lines.push("");
		lines.push(`価格帯: ${p.price_range.trim()}`);
	}
	const description = lines.join("\n").trim() || (p.description ?? "");
	const brief: ProductBrief = {
		name: p.name,
		description: description || "（商品情報未登録）",
	};
	if (p.category) brief.category = p.category.trim();
	return brief;
}

interface ValidationFailure { ok: false; status: number; error: string }
interface ValidationSuccess { ok: true; brief: ProductBrief; productId: string | null }

async function resolveBrief(body: unknown): Promise<ValidationFailure | ValidationSuccess> {
	if (!body || typeof body !== "object") {
		return { ok: false, status: 400, error: "リクエスト本文が必要です" };
	}
	const b = body as Record<string, unknown>;

	// Product-picker path: accept just a productId, fetch and build the brief.
	if (typeof b.productId === "string" && UUID_RE.test(b.productId)) {
		const supabase = getServiceClient();
		const { data: product, error } = await supabase
			.from("products")
			.select("id, name, description, category, features, target_market, price_range")
			.eq("id", b.productId)
			.single();
		if (error || !product) {
			return { ok: false, status: 404, error: "選択された商品が見つかりません" };
		}
		const brief = briefFromProduct(product as ProductRow);
		// Optional customization knobs override
		if (b.customization && typeof b.customization === "object") {
			brief.customization = b.customization as ProductBrief["customization"];
		}
		return { ok: true, brief, productId: product.id };
	}

	// Free-text path: accept a full productBrief object.
	const pb = b.productBrief;
	if (!pb || typeof pb !== "object") {
		return { ok: false, status: 400, error: "商品を選択するか、商品情報を入力してください" };
	}
	const o = pb as Record<string, unknown>;
	const name = typeof o.name === "string" ? o.name.trim() : "";
	const description = typeof o.description === "string" ? o.description.trim() : "";
	if (!name) return { ok: false, status: 400, error: "商品名（productBrief.name）が必要です" };
	if (!description) return { ok: false, status: 400, error: "商品情報（productBrief.description）が必要です" };
	if (name.length > 200) return { ok: false, status: 400, error: "商品名は200文字以内で入力してください" };
	if (description.length > 16_000) return { ok: false, status: 400, error: "商品情報は16,000文字以内で入力してください" };

	const brief: ProductBrief = { name, description };
	if (typeof o.category === "string" && o.category.trim()) brief.category = o.category.trim().slice(0, 200);
	if (typeof o.guarantee === "string" && o.guarantee.trim()) brief.guarantee = o.guarantee.trim().slice(0, 500);
	if (typeof o.notes === "string" && o.notes.trim()) brief.notes = o.notes.trim().slice(0, 4000);
	if (Array.isArray(o.bonuses)) {
		brief.bonuses = o.bonuses
			.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
			.slice(0, 20)
			.map((s) => s.trim().slice(0, 200));
	}
	if (o.price && typeof o.price === "object") {
		const p = o.price as Record<string, unknown>;
		const price: NonNullable<ProductBrief["price"]> = {};
		const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
		const list = num(p.listJpy);
		const sale = num(p.saleJpy);
		const shipping = num(p.shippingJpy);
		if (list !== undefined) price.listJpy = Math.floor(list);
		if (sale !== undefined) price.saleJpy = Math.floor(sale);
		if (shipping !== undefined) price.shippingJpy = Math.floor(shipping);
		if (Object.keys(price).length > 0) brief.price = price;
	}
	if (o.customization && typeof o.customization === "object") {
		brief.customization = o.customization as ProductBrief["customization"];
	}
	return { ok: true, brief, productId: null };
}

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => null);
	const v = await resolveBrief(body);
	if (!v.ok) return Response.json({ error: v.error }, { status: v.status });

	const { brief: productBrief, productId } = v;

	const supabase = getServiceClient();
	const { data: inserted, error: insErr } = await supabase
		.from("screenplays")
		.insert({
			product_id: productId,
			title: productBrief.name,
			product_info_snapshot: productBrief,
			status: "generating",
		})
		.select("id")
		.single();
	if (insErr || !inserted) {
		console.error("[screenplays] insert failed:", insErr);
		return Response.json({ error: "台本の作成に失敗しました" }, { status: 500 });
	}
	const screenplayId = inserted.id as string;

	try {
		const run = await start(screenplayWorkflow, [{
			screenplayId,
			mode: "initial",
			productBrief,
		}]);
		await supabase
			.from("screenplays")
			.update({ last_run_id: run.runId })
			.eq("id", screenplayId);
		return Response.json({ id: screenplayId, runId: run.runId });
	} catch (err) {
		await supabase
			.from("screenplays")
			.update({ status: "failed" })
			.eq("id", screenplayId);
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[screenplays] workflow start failed:", msg);
		return Response.json({ error: "生成の開始に失敗しました" }, { status: 500 });
	}
}
