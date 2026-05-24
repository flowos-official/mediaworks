import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";

export const maxDuration = 5;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const sb = auth.sb;

  const { data, error } = await sb
    .from("product_selection_events")
    .select(`
      id, event_type, from_status, to_status, from_assignee_id, to_assignee_id,
      broadcast_id, closed_reason, note, is_system, created_at,
      actor:profiles(display_name, email)
    `)
    .eq("selection_id", id)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[selections/events] query failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ events: data ?? [] });
}
