import { requireUser } from "@/lib/auth/require-user";
import { type NextRequest, NextResponse } from "next/server";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const { id } = await params;

  const { data, error } = await auth.sb
    .from("broadcast_products")
    .select(
      "product_id, position, name, image_url, price_jpy, original_price_jpy, discount_rate, sale_label, tax_incl, in_stock_at_capture, source, captured_at",
    )
    .eq("broadcast_id", id)
    .order("position", { ascending: true });

  if (error) {
    console.error("[broadcasts/[id]/products] query failed:", error.message);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  return NextResponse.json(
    { products: data ?? [] },
    {
      headers: {
        "Cache-Control": "private, max-age=300",
      },
    },
  );
}
