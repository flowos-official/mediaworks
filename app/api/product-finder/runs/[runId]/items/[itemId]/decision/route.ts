/**
 * POST /api/product-finder/runs/:runId/items/:itemId/decision
 *
 * Records interest or exclusion and nothing else. It deliberately does NOT
 * create a product_selection, kick off Research, or promote anything: marking a
 * row interesting is a note to oneself, and a surface that silently starts
 * downstream work from a single click teaches operators not to click.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/require-user";

export const maxDuration = 10;

const bodySchema = z
	.object({
		decision: z.enum(["interested", "excluded"]),
		reason: z.string().trim().max(500).optional(),
	})
	.strict();

export async function POST(
	req: NextRequest,
	ctx: { params: Promise<{ runId: string; itemId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { runId, itemId } = await ctx.params;

	let parsed;
	try {
		parsed = bodySchema.parse(await req.json());
	} catch (error) {
		return NextResponse.json(
			{ code: "invalid_decision", message: error instanceof Error ? error.message : "invalid body" },
			{ status: 400 },
		);
	}

	// The item must belong to a run this user owns. Checked explicitly rather
	// than relying on the insert failing: RLS has no write policy here, so the
	// service client would otherwise accept an item id from any run.
	const { data: item, error: itemError } = await auth.sb
		.from("product_recommendation_items")
		.select("id, run:product_recommendation_runs!inner(id, created_by)")
		.eq("id", itemId)
		.eq("run_id", runId)
		.maybeSingle();
	if (itemError) {
		console.error("[product-finder] decision item read failed:", itemError);
		return NextResponse.json({ code: "decision_failed" }, { status: 500 });
	}
	const owner = (item as { run?: { created_by?: string } } | null)?.run?.created_by;
	if (!item || owner !== auth.user.id) {
		return NextResponse.json({ code: "not_found" }, { status: 404 });
	}

	const { data, error } = await auth.sb
		.from("product_recommendation_decisions")
		.upsert(
			{
				item_id: itemId,
				user_id: auth.user.id,
				decision: parsed.decision,
				reason: parsed.reason ?? null,
			},
			{ onConflict: "item_id,user_id" },
		)
		.select("id, decision, reason, created_at")
		.single();
	if (error) {
		console.error("[product-finder] decision upsert failed:", error);
		return NextResponse.json({ code: "decision_failed" }, { status: 500 });
	}

	return NextResponse.json(data, { status: 200 });
}
