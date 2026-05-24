import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";

export const maxDuration = 5;
const VALID_FIELDS = new Set(["sourcing_note", "scheduled_note", "closed_note"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const { field, value } = (await req.json()) as { field: string; value: string | null };

  if (!VALID_FIELDS.has(field))
    return NextResponse.json({ error: "invalid field" }, { status: 400 });

  const sb = auth.sb;
  const { error: updErr } = await sb
    .from("product_selections")
    .update({ [field]: value })
    .eq("id", id);
  if (updErr) {
    console.error("[selections/note] update failed", updErr);
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  await sb.from("product_selection_events").insert({
    selection_id: id,
    event_type: "note_updated",
    actor_id: auth.user.id,
    note: `${field}: ${(value ?? "").slice(0, 120)}`,
  });

  invalidateSelectionsAfterMutation("note");
  return NextResponse.json({ ok: true });
}
