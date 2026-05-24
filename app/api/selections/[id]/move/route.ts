import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";
import type { SelectionStatus, ClosedReason } from "@/lib/selections/types";

export const maxDuration = 10;

const VALID_TRANSITIONS: Record<SelectionStatus, SelectionStatus[]> = {
  selected:  ["sourcing", "closed"],
  sourcing:  ["selected", "scheduled", "closed"],
  scheduled: ["sourcing", "closed"],
  closed:    [], // use /reopen
};

interface MoveBody {
  to_status: SelectionStatus;
  broadcast_id?: string | null;
  scheduled_note?: string | null;
  closed_reason?: ClosedReason | null;
  closed_note?: string | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const sb = auth.sb;
  const { data: current } = await sb
    .from("product_selections")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  const allowed = VALID_TRANSITIONS[current.status as SelectionStatus] ?? [];
  if (!allowed.includes(body.to_status)) {
    return NextResponse.json(
      { error: `transition ${current.status} -> ${body.to_status} not allowed` },
      { status: 400 },
    );
  }

  const patch: Record<string, unknown> = { status: body.to_status };
  const events: Array<Record<string, unknown>> = [];

  if (body.to_status === "scheduled") {
    if (!body.broadcast_id && !body.scheduled_note) {
      return NextResponse.json(
        { error: "scheduled requires broadcast_id or scheduled_note" },
        { status: 400 },
      );
    }
    if (body.broadcast_id) patch.broadcast_id = body.broadcast_id;
    if (body.scheduled_note !== undefined) patch.scheduled_note = body.scheduled_note;
    if (body.broadcast_id) {
      events.push({
        event_type: "broadcast_linked",
        broadcast_id: body.broadcast_id,
        actor_id: auth.user.id,
      });
    }
  }

  if (body.to_status === "closed") {
    if (!body.closed_reason) {
      return NextResponse.json(
        { error: "closed requires closed_reason" },
        { status: 400 },
      );
    }
    patch.closed_reason = body.closed_reason;
    patch.closed_at = new Date().toISOString();
    patch.closed_by = auth.user.id;
    if (body.closed_note !== undefined) patch.closed_note = body.closed_note;
    events.push({
      event_type: "closed",
      closed_reason: body.closed_reason,
      actor_id: auth.user.id,
      note: body.closed_note ?? null,
    });
  }

  events.unshift({
    event_type: "status_changed",
    from_status: current.status,
    to_status: body.to_status,
    actor_id: auth.user.id,
  });

  // Optimistic lock
  const { data: updated, error: updErr } = await sb
    .from("product_selections")
    .update(patch)
    .eq("id", id)
    .eq("status", current.status)
    .select("id")
    .maybeSingle();

  if (updErr) {
    console.error("[selections/move] update failed", updErr);
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json(
      { error: "stale — selection moved by someone else; refresh and retry" },
      { status: 409 },
    );
  }

  for (const e of events) {
    await sb.from("product_selection_events").insert({ selection_id: id, ...e });
  }

  invalidateSelectionsAfterMutation("move");
  return NextResponse.json({ ok: true });
}
