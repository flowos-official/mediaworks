import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { getRuntimeMarketCountry } from "@/lib/market/runtime-market";

export const maxDuration = 30;

/**
 * POST: queue enrichment for a productId. Returns 202 immediately.
 * Triggers internal worker via `after()` (Vercel Fluid Compute).
 */
export async function POST(
	req: NextRequest,
	ctx: { params: Promise<{ productId: string }> },
) {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { productId } = await ctx.params;
	const sb = getServiceClient();

	// Check if product exists + current status
	const { data: product, error: prodErr } = await sb
		.from("discovered_products")
		.select("id, enrichment_status, c_package")
		.eq("id", productId)
		.eq("country", getRuntimeMarketCountry())
		.maybeSingle();

	if (prodErr) {
		return NextResponse.json({ error: prodErr.message }, { status: 500 });
	}
	if (!product) {
		return NextResponse.json({ error: "product not found" }, { status: 404 });
	}

	// Idempotency: if already running or queued, return existing state
	if (
		product.enrichment_status === "queued" ||
		product.enrichment_status === "running"
	) {
		return NextResponse.json(
			{ productId, status: product.enrichment_status },
			{ status: 202 },
		);
	}

	// If completed, return cached package unless client explicitly forces refresh
	const force = req.nextUrl.searchParams.get("force") === "1";
	if (product.enrichment_status === "completed" && !force) {
		return NextResponse.json(
			{ productId, status: "completed", cached: true },
			{ status: 200 },
		);
	}

	// Mark as queued
	const { error: updErr } = await sb
		.from("discovered_products")
		.update({
			enrichment_status: "queued",
			enrichment_started_at: new Date().toISOString(),
			enrichment_error: null,
		})
		.eq("id", productId);
	if (updErr) {
		return NextResponse.json({ error: updErr.message }, { status: 500 });
	}

	// Trigger worker via after() — keeps the function alive post-response
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		console.error(`[enrich trigger] CRON_SECRET missing — worker trigger blocked for ${productId}`);
		await sb
			.from("discovered_products")
			.update({ enrichment_status: "failed", enrichment_error: "cron_secret_missing" })
			.eq("id", productId);
		return NextResponse.json(
			{ error: "CRON_SECRET not configured" },
			{ status: 500 },
		);
	}

	const workerUrl = new URL(
		`/api/discovery/enrich/${productId}/worker`,
		req.nextUrl.origin,
	);

	after(async () => {
		try {
			await fetch(workerUrl, {
				method: "POST",
				headers: { Authorization: `Bearer ${cronSecret}` },
				signal: AbortSignal.timeout(62_000),
			});
		} catch (err) {
			console.error(
				`[enrich trigger] worker fetch failed for ${productId}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	});

	return NextResponse.json({ productId, status: "queued" }, { status: 202 });
}

/**
 * GET: poll current enrichment status + c_package (if completed).
 */
export async function GET(
	_req: NextRequest,
	ctx: { params: Promise<{ productId: string }> },
) {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { productId } = await ctx.params;
	const sb = getServiceClient();

	const { data, error } = await sb
		.from("discovered_products")
		.select("id, enrichment_status, c_package, enrichment_error, enrichment_completed_at")
		.eq("id", productId)
		.eq("country", getRuntimeMarketCountry())
		.maybeSingle();

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	if (!data) {
		return NextResponse.json({ error: "product not found" }, { status: 404 });
	}

	return NextResponse.json({
		productId,
		status: data.enrichment_status,
		c_package: data.c_package,
		error: data.enrichment_error,
		completed_at: data.enrichment_completed_at,
	});
}
