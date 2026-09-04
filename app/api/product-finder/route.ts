/**
 * POST /api/product-finder — rank stored evidence. Reaches no external service.
 *
 * A `supplemented` request is refused with 409 and a code rather than being
 * quietly downgraded to stored-only. External research costs money and takes
 * time; an operator who asked for it must learn that it did not happen, not
 * receive a cheaper answer wearing the same shape.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { parseProductFinderQuery } from "@/lib/product-finder/request";
import { runStoredProductFinder } from "@/lib/product-finder/run";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ code: "invalid_json" }, { status: 400 });
	}

	// Checked before parsing, because the strict parser rejects the field with
	// a generic validation error and the caller could not tell this refusal
	// apart from a typo.
	if (typeof body === "object" && body !== null && "mode" in body && body.mode !== "stored_only") {
		return NextResponse.json({ code: "explicit_supplement_required" }, { status: 409 });
	}

	let query;
	try {
		query = parseProductFinderQuery(body);
	} catch (error) {
		return NextResponse.json(
			{ code: "invalid_query", message: error instanceof Error ? error.message : "invalid query" },
			{ status: 400 },
		);
	}

	try {
		const result = await runStoredProductFinder(auth.sb, auth.user.id, query);
		return NextResponse.json(result, { status: 201 });
	} catch (error) {
		// The run row already carries the failure; the response says only that
		// it failed. The underlying message can name internal tables.
		console.error("[product-finder] run failed:", error);
		return NextResponse.json({ code: "product_finder_failed" }, { status: 500 });
	}
}
