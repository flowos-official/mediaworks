import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";

export const maxDuration = 5;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { note } = (await req.json().catch(() => ({}))) as { note?: string };

  const sb = auth.sb;
  const { data: row } = await sb
    .from("product_selections")
    .select("id, status, discovered_product_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.status !== "closed")
    return NextResponse.json({ error: "only closed selections can reopen" }, { status: 400 });

  // Prevent reopen if another active selection has since taken over.
  const { data: blocker } = await sb
    .from("product_selections")
    .select("id")
    .eq("discovered_product_id", row.discovered_product_id)
    .neq("status", "closed")
    .maybeSingle();
  if (blocker)
    return NextResponse.json(
      { error: "another active selection exists for this product" },
      { status: 409 },
    );

  const { error: updErr } = await sb
    .from("product_selections")
    .update({
      status: "sourcing",
      closed_reason: null,
      closed_at: null,
      closed_by: null,
      closed_note: null,
    })
    .eq("id", id)
    .eq("status", "closed");
  if (updErr) {
    console.error("[selections/reopen] update failed", updErr);
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  await sb.from("product_selection_events").insert([
    { selection_id: id, event_type: "reopened", actor_id: auth.user.id, note: note ?? null },
    {
      selection_id: id, event_type: "status_changed",
      from_status: "closed", to_status: "sourcing", actor_id: auth.user.id,
    },
  ]);

  invalidateSelectionsAfterMutation("reopen");
  return NextResponse.json({ ok: true });
}
