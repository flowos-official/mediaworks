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
  const { assignee_id } = (await req.json()) as { assignee_id: string | null };

  const sb = auth.sb;
  const { data: prev } = await sb
    .from("product_selections")
    .select("assignee_id")
    .eq("id", id)
    .maybeSingle();
  if (!prev) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { error: updErr } = await sb
    .from("product_selections")
    .update({ assignee_id })
    .eq("id", id);
  if (updErr) {
    console.error("[selections/assign] update failed", updErr);
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  await sb.from("product_selection_events").insert({
    selection_id: id,
    event_type: "assignee_changed",
    from_assignee_id: prev.assignee_id,
    to_assignee_id: assignee_id,
    actor_id: auth.user.id,
  });

  invalidateSelectionsAfterMutation("assign");
  return NextResponse.json({ ok: true });
}
