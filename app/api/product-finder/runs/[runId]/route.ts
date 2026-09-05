/**
 * GET /api/product-finder/runs/:runId — read one completed run.
 *
 * The slug is `runId`, not `id`: the decision route below this path already
 * uses `[runId]`, and Next.js refuses two different slug names at the same
 * position. The plan specified both spellings and the app would not boot.
 *
 * Scoped by both run id and created_by. RLS already restricts this to the
 * owner; the explicit filter is the second lock, and it also makes a run
 * belonging to someone else a 404 rather than an empty 200.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import type { ProductFinderItem, ProductFinderResult } from "@/lib/product-finder/types";

export const maxDuration = 15;

interface RunRow {
	id: string;
	mode: ProductFinderResult["mode"];
	query_json: ProductFinderResult["query"];
	status: string;
	candidate_count: number;
	created_at: string;
	completed_at: string | null;
}

interface ItemRow {
	id: string;
	canonical_product_id: string;
	rank: number;
	opportunity_index: number | string;
	expected_contribution_profit_jpy: number | string | null;
	axes: ProductFinderItem["axes"];
	confidence: ProductFinderItem["confidence"];
	reasons: string[];
	risks: string[];
	missing_data: string[];
	canonical_product: { display_name: string; normalized_category: string | null } | null;
}

/** numeric(6,5) and numeric come back as strings from PostgREST; parse rather
 *  than trusting the shape, and never substitute 0 for an absent profit. */
function num(value: number | string | null): number | null {
	if (value === null) return null;
	const parsed = typeof value === "number" ? value : Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { runId } = await ctx.params;

	const { data: run, error: runError } = await auth.sb
		.from("product_recommendation_runs")
		.select("id, mode, query_json, status, candidate_count, created_at, completed_at")
		.eq("id", runId)
		.eq("created_by", auth.user.id)
		.maybeSingle();
	if (runError) {
		console.error("[product-finder] run read failed:", runError);
		return NextResponse.json({ code: "run_read_failed" }, { status: 500 });
	}
	if (!run) return NextResponse.json({ code: "not_found" }, { status: 404 });

	const typedRun = run as RunRow;

	const { data: items, error: itemsError } = await auth.sb
		.from("product_recommendation_items")
		.select(
			"id, canonical_product_id, rank, opportunity_index, expected_contribution_profit_jpy, axes, confidence, reasons, risks, missing_data, canonical_product:canonical_products(display_name, normalized_category)",
		)
		.eq("run_id", runId)
		.order("rank", { ascending: true });
	if (itemsError) {
		console.error("[product-finder] item read failed:", itemsError);
		return NextResponse.json({ code: "run_read_failed" }, { status: 500 });
	}

	const result: ProductFinderResult = {
		runId: typedRun.id,
		mode: typedRun.mode,
		generatedAt: typedRun.completed_at ?? typedRun.created_at,
		query: typedRun.query_json,
		candidateCount: typedRun.candidate_count,
		items: ((items ?? []) as unknown as ItemRow[]).map((row) => ({
			id: row.id,
			canonicalProductId: row.canonical_product_id,
			rank: row.rank,
			name: row.canonical_product?.display_name ?? "",
			category: row.canonical_product?.normalized_category ?? null,
			opportunityIndex: num(row.opportunity_index) ?? 0,
			expectedContributionProfitJpy: num(row.expected_contribution_profit_jpy),
			axes: row.axes,
			confidence: row.confidence,
			reasons: row.reasons,
			risks: row.risks,
			missingData: row.missing_data,
		})),
	};

	return NextResponse.json({ ...result, status: typedRun.status });
}
