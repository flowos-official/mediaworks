/**
 * POST /api/product-finder/runs/:runId/supplement
 *
 * The ONLY endpoint in the product-finder surface that may reach an external
 * provider, and it does so only for the gaps the operator ticked. Everything
 * else on this surface is stored-only, and a static test enforces that no
 * stored-only module can import a provider at all.
 *
 * The status codes carry a distinction that matters to the operator: 200 for a
 * completed or partial run (something was found and a new ranking exists), 502
 * when every provider failed — and even then the body names the ORIGINAL run,
 * because a search provider being down is not a reason to lose the result they
 * were already looking at.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { braveSearchItems } from "@/lib/brave";
import { rakutenItemSearch } from "@/lib/rakuten";
import {
	createSupplementRepository,
	runSupplementalResearch,
	SupplementError,
} from "@/lib/intelligence/supplement/run";
import {
	parseSupplementRequest,
	SupplementRequestError,
} from "@/lib/intelligence/supplement/types";

// External providers plus a page fetch per result. Well under the ceiling, but
// it is not a 10-second endpoint.
export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
	req: NextRequest,
	ctx: { params: Promise<{ runId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { runId } = await ctx.params;
	if (!UUID_RE.test(runId)) {
		return NextResponse.json({ code: "invalid_run", message: "invalid run id" }, { status: 404 });
	}

	const body = await req.json().catch(() => null);
	const canonicalProductId =
		body && typeof body === "object" && typeof (body as Record<string, unknown>).canonicalProductId === "string"
			? ((body as Record<string, unknown>).canonicalProductId as string).trim()
			: "";
	if (!UUID_RE.test(canonicalProductId)) {
		return NextResponse.json(
			{ code: "invalid_product", message: "canonicalProductId is required" },
			{ status: 400 },
		);
	}

	let request;
	try {
		request = parseSupplementRequest(body);
	} catch (error) {
		return NextResponse.json(
			{
				code: "invalid_gaps",
				message: error instanceof SupplementRequestError ? error.message : "invalid gaps",
			},
			{ status: 400 },
		);
	}

	try {
		const result = await runSupplementalResearch(
			// Reads and the recommendation writes go through the USER's client so
			// RLS still decides; only evidence_items takes the service client,
			// which is service-role-write by design.
			createSupplementRepository(auth.sb, getServiceClient()),
			{ braveSearch: braveSearchItems, rakutenSearch: rakutenItemSearch },
			{
				recommendationRunId: runId,
				canonicalProductId,
				userId: auth.user.id,
				gaps: request.gaps,
			},
		);

		return NextResponse.json(result, { status: result.status === "failed" ? 502 : 200 });
	} catch (error) {
		if (error instanceof SupplementError) {
			return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
		}
		console.error("[supplement] run failed:", error instanceof Error ? error.message : error);
		return NextResponse.json(
			{ code: "supplement_failed", message: "追加調査に失敗しました" },
			{ status: 500 },
		);
	}
}
