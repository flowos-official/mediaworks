import { NextRequest, NextResponse } from "next/server";
import { enrichProduct } from "@/lib/discovery/enrich-agent";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 60;

/**
 * Internal worker — NEVER called by browser. Invoked via fetch from the
 * POST handler's `after()` callback. Protected by CRON_SECRET.
 */
export async function POST(
	req: NextRequest,
	ctx: { params: Promise<{ productId: string }> },
) {
	const secret = process.env.CRON_SECRET;
	if (secret) {
		const header = req.headers.get("authorization");
		if (header !== `Bearer ${secret}`) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
	}

	const { productId } = await ctx.params;
	const sb = getServiceClient();

	// Load product
	const { data: product, error: prodErr } = await sb
		.from("discovered_products")
		.select(
			"id, name, product_url, price_jpy, category, seller_name, review_count, review_avg, tv_fit_reason",
		)
		.eq("id", productId)
		.maybeSingle();

	if (prodErr || !product) {
		return NextResponse.json(
			{ error: prodErr?.message ?? "product not found" },
			{ status: 404 },
		);
	}

	// Mark running
	await sb
		.from("discovered_products")
		.update({ enrichment_status: "running" })
		.eq("id", productId);

	try {
		const pkg = await enrichProduct({
			productUrl: product.product_url,
			name: product.name,
			priceJpy: product.price_jpy,
			category: product.category,
			sellerName: product.seller_name,
			reviewCount: product.review_count,
			reviewAvg: product.review_avg,
			tvFitReason: product.tv_fit_reason,
		});

		await sb
			.from("discovered_products")
			.update({
				enrichment_status: "completed",
				enrichment_completed_at: new Date().toISOString(),
				c_package: pkg,
				enrichment_error: pkg.error ?? null,
			})
			.eq("id", productId);

		return NextResponse.json({ ok: true, productId, partial: pkg.partial });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[enrich worker] ${productId} failed:`, msg);
		await sb
			.from("discovered_products")
			.update({
				enrichment_status: "failed",
				enrichment_error: msg.slice(0, 500),
				enrichment_completed_at: new Date().toISOString(),
			})
			.eq("id", productId);
		return NextResponse.json({ ok: false, productId, error: msg }, { status: 500 });
	}
}
