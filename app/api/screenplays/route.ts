import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { getServiceClient } from "@/lib/supabase";
import { screenplayWorkflow } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 60;

export async function GET() {
	const supabase = getServiceClient();
	const { data, error } = await supabase
		.from("screenplays")
		.select("id, title, status, current_version_id, created_at, updated_at")
		.order("updated_at", { ascending: false })
		.limit(50);
	if (error) return Response.json({ error: error.message }, { status: 500 });
	return Response.json({ screenplays: data ?? [] });
}

function isProductBrief(x: unknown): x is ProductBrief {
	if (!x || typeof x !== "object") return false;
	const o = x as Record<string, unknown>;
	return typeof o.name === "string" && typeof o.description === "string";
}

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	if (!isProductBrief(body.productBrief)) {
		return Response.json(
			{ error: "productBrief.name + productBrief.description required" },
			{ status: 400 },
		);
	}
	const productBrief: ProductBrief = body.productBrief;
	const productId: string | null =
		typeof body.productId === "string" ? body.productId : null;

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
		return Response.json(
			{ error: insErr?.message ?? "failed to create" },
			{ status: 500 },
		);
	}
	const screenplayId = inserted.id as string;

	try {
		const run = await start(screenplayWorkflow, [
			{
				screenplayId,
				mode: "initial",
				productBrief,
			},
		]);
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
		return Response.json({ error: msg }, { status: 500 });
	}
}
