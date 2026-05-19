import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import type { CPackage } from "@/lib/discovery/types";

export const maxDuration = 60;

function buildDescriptionFromCPackage(
	cp: CPackage | null,
	fallback: string | null,
): string {
	if (!cp) return fallback ?? "";
	const parts: string[] = [];
	if (cp.tv_script_draft && cp.tv_script_draft.trim().length > 0) {
		parts.push(cp.tv_script_draft.trim());
	}
	const mfgName = cp.manufacturer?.name;
	if (mfgName) parts.push(`製造元: ${mfgName}`);
	if (cp.sns_trend?.signal_strength && cp.sns_trend.signal_strength !== "none") {
		const sourceCount = cp.sns_trend.sources?.length ?? 0;
		parts.push(`SNS シグナル: ${cp.sns_trend.signal_strength} (${sourceCount}件)`);
	}
	return parts.join("\n\n").trim() || fallback || "";
}

function buildFeaturesFromCPackage(cp: CPackage | null): string[] {
	if (!cp) return [];
	const features: string[] = [];
	const mfgName = cp.manufacturer?.name;
	if (mfgName) features.push(`製造元: ${mfgName}`);
	if (cp.moq_hint) features.push(`MOQ: ${cp.moq_hint}`);
	const cost = cp.wholesale_estimate?.estimated_cost_jpy;
	if (cost != null && cost > 0) {
		features.push(`卸値推定: ¥${cost.toLocaleString()}`);
	}
	return features;
}

function formatPriceRange(priceJpy: number | null): string | null {
	if (!priceJpy || priceJpy <= 0) return null;
	return `¥${priceJpy.toLocaleString()}`;
}

export async function POST(
	_request: NextRequest,
	{ params }: { params: Promise<{ productId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { productId: dpId } = await params;
	if (!dpId) {
		return NextResponse.json({ error: "productId required" }, { status: 400 });
	}

	// Service client: products is Group B (member/admin only). The user is already
	// authorized via requireUser above; service client is used here to avoid the
	// extra cookie-roundtrip cost on a server-only path.
	const sb = getServiceClient();

	// 1. Load the discovered product.
	const { data: dp, error: dpErr } = await sb
		.from("discovered_products")
		.select(
			"id, name, category, price_jpy, tv_fit_reason, c_package, enrichment_status",
		)
		.eq("id", dpId)
		.maybeSingle();

	if (dpErr) {
		console.error("[promote-to-research] load failed", dpErr);
		return NextResponse.json({ error: "load failed" }, { status: 500 });
	}
	if (!dp) {
		return NextResponse.json({ error: "discovered product not found" }, { status: 404 });
	}
	if (dp.enrichment_status !== "completed") {
		return NextResponse.json(
			{ error: "c_package not ready, run enrichment first" },
			{ status: 409 },
		);
	}

	// 2. Idempotency: if already promoted, return existing.
	const { data: existing } = await sb
		.from("products")
		.select("id")
		.eq("discovered_product_id", dpId)
		.maybeSingle();

	if (existing) {
		return NextResponse.json({
			productId: existing.id,
			alreadyPromoted: true,
		});
	}

	// 3. Insert products row.
	const cp = (dp.c_package as CPackage | null) ?? null;
	const insertPayload = {
		name: dp.name,
		description: buildDescriptionFromCPackage(cp, dp.tv_fit_reason),
		category: dp.category,
		features: buildFeaturesFromCPackage(cp),
		price_range: formatPriceRange(dp.price_jpy),
		target_market: null as string | null,
		status: "extracted" as const,
		ingest_source: "discovery_promotion" as const,
		discovered_product_id: dpId,
	};

	const { data: inserted, error: insErr } = await sb
		.from("products")
		.insert(insertPayload)
		.select("id")
		.single();

	if (insErr || !inserted) {
		// Postgres unique_violation = 23505. The UNIQUE index on
		// products.discovered_product_id guarantees only one promotion per
		// discovered_product. If two requests race past the idempotency
		// check above, the second one lands here.
		if (insErr && (insErr as { code?: string }).code === "23505") {
			const { data: raced } = await sb
				.from("products")
				.select("id")
				.eq("discovered_product_id", dpId)
				.maybeSingle();
			if (raced) {
				return NextResponse.json({
					productId: raced.id,
					alreadyPromoted: true,
				});
			}
		}
		console.error("[promote-to-research] insert failed", insErr);
		return NextResponse.json({ error: "promotion failed" }, { status: 500 });
	}
	const newProductId = inserted.id as string;

	// 4. Activate the dormant deep_dive learning signal (P5).
	const { error: fbErr } = await sb.from("product_feedback").insert({
		discovered_product_id: dpId,
		action: "deep_dive",
		reason: "promoted_to_research",
	});
	if (fbErr) {
		console.warn("[promote-to-research] deep_dive feedback insert failed", fbErr);
	}

	// 5. Fire-and-forget synthesize.
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		console.error(
			"[promote-to-research] CRON_SECRET not set — synthesize will not start",
		);
	}
	const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
	fetch(`${baseUrl}/api/analyze/synthesize`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${cronSecret ?? ""}`,
		},
		body: JSON.stringify({ productId: newProductId }),
	}).catch((err) => {
		console.error(`[promote-to-research:${newProductId}] synthesize trigger failed`, err);
	});

	return NextResponse.json({
		productId: newProductId,
		alreadyPromoted: false,
	});
}
