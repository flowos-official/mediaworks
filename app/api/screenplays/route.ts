import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { screenplayWorkflow } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "@/lib/screenplay/types";
import { loadProductBriefForScreenplay } from "@/lib/screenplay/product-brief";
import { validateImportedMarkdown } from "@/lib/screenplay/import/validate";
import {
	sanitizeScreenplayCustomization,
	sanitizeScreenplayOffer,
} from "@/lib/screenplay/customization";

export const maxDuration = 60;

export async function GET() {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const supabase = getServiceClient();
	const { data, error } = await supabase
		.from("screenplays")
		.select("id, title, status, current_version_id, created_at, updated_at, product_id, product_info_snapshot")
		.order("updated_at", { ascending: false })
		.limit(50);
	if (error) return Response.json({ error: error.message }, { status: 500 });
	return Response.json({ screenplays: data ?? [] });
}

interface ValidationFailure { ok: false; status: number; error: string }
interface ValidationSuccess { ok: true; brief: ProductBrief; productId: string | null }

function resolveBrief(body: unknown): ValidationFailure | ValidationSuccess {
	if (!body || typeof body !== "object") {
		return { ok: false, status: 400, error: "リクエスト本文が必要です" };
	}
	const b = body as Record<string, unknown>;

	const pb = b.productBrief;
	if (!pb || typeof pb !== "object") {
		return { ok: false, status: 400, error: "商品情報 (productBrief) を入力してください" };
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
		brief.customization = sanitizeScreenplayCustomization(o.customization);
	}
	return { ok: true, brief, productId: null };
}

export async function POST(request: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const body = await request.json().catch(() => null);
	const supabase = getServiceClient();
	const productId =
		body && typeof body === "object" && typeof (body as Record<string, unknown>).productId === "string"
			? ((body as Record<string, unknown>).productId as string).trim()
			: "";
	const v = productId
		? await loadProductBriefForScreenplay(supabase, productId)
		: resolveBrief(body);
	if (!v.ok) return Response.json({ error: v.error }, { status: v.status });

	const productBrief: ProductBrief = { ...v.brief };
	if (productId && body && typeof body === "object") {
		const bodyRecord = body as Record<string, unknown>;
		const customization = sanitizeScreenplayCustomization(bodyRecord.customization);
		if (customization) productBrief.customization = customization;
		Object.assign(productBrief, sanitizeScreenplayOffer(bodyRecord.offer));
	}

	// Import path: an operator-reviewed, pre-normalized draft seeds v1 directly.
	let importedMarkdown: string | undefined;
	if (body && typeof body === "object" && "importedMarkdown" in (body as Record<string, unknown>)) {
		const val = validateImportedMarkdown((body as Record<string, unknown>).importedMarkdown);
		if (!val.ok) return Response.json({ error: val.error }, { status: 400 });
		importedMarkdown = val.markdown;
	}

	const rawSourceKind =
		body && typeof body === "object" ? (body as Record<string, unknown>).sourceKind : undefined;
	const clientSourceKind =
		rawSourceKind === "upload" || rawSourceKind === "url" ? rawSourceKind : null;
	const sourceKind: "upload" | "url" | "import" | "product" | null = importedMarkdown
		? "import"
		: v.productId
			? "product"
			: clientSourceKind;

	const { data: inserted, error: insErr } = await supabase
		.from("screenplays")
		.insert({
			product_id: v.productId,
			title: productBrief.name,
			product_info_snapshot: productBrief,
			status: "generating",
			last_error: null,
			source_kind: sourceKind,
		})
		.select("id")
		.single();
	if (insErr || !inserted) {
		console.error("[screenplays] insert failed:", insErr);
		return Response.json({ error: "台本の作成に失敗しました" }, { status: 500 });
	}
	const screenplayId = inserted.id as string;

	try {
		const run = await start(screenplayWorkflow, [
			importedMarkdown
				? { screenplayId, mode: "import" as const, productBrief, importedMarkdown }
				: { screenplayId, mode: "initial" as const, productBrief },
		]);
		await supabase
			.from("screenplays")
			.update({ last_run_id: run.runId })
			.eq("id", screenplayId);
		return Response.json({ id: screenplayId, runId: run.runId });
	} catch (err) {
		await supabase
			.from("screenplays")
			.update({
				status: "failed",
				last_error: "台本生成ワークフローを開始できませんでした。管理者に連絡してください。",
			})
			.eq("id", screenplayId);
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[screenplays] workflow start failed:", msg);
		return Response.json({ error: "生成の開始に失敗しました" }, { status: 500 });
	}
}
