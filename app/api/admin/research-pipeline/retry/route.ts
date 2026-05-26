import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { determineRetryStage } from "@/lib/research/retry-stage";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireUser(["admin"]);
  if ("error" in auth) return auth.error;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured — internal fetch impossible" },
      { status: 500 },
    );
  }

  let body: { productId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const productId = body.productId;
  if (!productId || typeof productId !== "string") {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }

  const sb = getServiceClient();
  const { data: product, error: prodErr } = await sb
    .from("products")
    .select("id, status, description")
    .eq("id", productId)
    .maybeSingle();

  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 });
  if (!product) return NextResponse.json({ error: "product not found" }, { status: 404 });

  if (product.status !== "failed" && product.status !== "analyzing") {
    return NextResponse.json(
      { error: `cannot retry from status='${product.status}' (only failed/analyzing)` },
      { status: 400 },
    );
  }

  const stage = determineRetryStage({ description: product.description });

  if (stage === "extract") {
    // extract stage requires fileBase64 + mimeType + fileName, which the admin route
    // doesn't have. For Phase 2 we explicitly tell the operator that extract-stage
    // retries must re-upload the file. (Auto re-extract from storage URL is Phase 3+.)
    // Row is intentionally NOT touched — leaving status='failed' so the operator
    // can clearly see the row needs re-upload instead of waiting on a phantom retry.
    return NextResponse.json(
      {
        error:
          "extract-stage retry requires file re-upload (description was never extracted). " +
          "Please re-upload the source file from the main UI.",
        retriedStage: null,
      },
      { status: 422 },
    );
  }

  // Reset row to analyzing + clear error_reason BEFORE firing the synthesize trigger,
  // so the operator sees the new in-flight state immediately.
  const { error: resetErr } = await sb
    .from("products")
    .update({ status: "analyzing", error_reason: null })
    .eq("id", productId);
  if (resetErr) return NextResponse.json({ error: resetErr.message }, { status: 500 });

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  fetch(`${baseUrl}/api/analyze/synthesize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cronSecret}`,
    },
    body: JSON.stringify({ productId }),
  }).catch((err) => {
    console.error(`[admin/retry][${productId}] synthesize trigger failed:`, err);
  });

  return NextResponse.json({ ok: true, retriedStage: stage });
}
