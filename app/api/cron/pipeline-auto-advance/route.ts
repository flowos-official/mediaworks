import { NextResponse } from "next/server";
import { hasInternalSecret } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { invalidateSelectionsAfterMutation } from "@/lib/selections/cached";

export const maxDuration = 60;

function todayJstISO(): string {
  const now = new Date();
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  if (!hasInternalSecret(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sb = getServiceClient();
  const today = todayJstISO();

  const { data: candidates, error: selErr } = await sb
    .from("product_selections")
    .select("id, broadcast_id, broadcast:broadcasts!inner(air_date)")
    .eq("status", "scheduled")
    .not("broadcast_id", "is", null)
    .lt("broadcast.air_date", today);

  if (selErr) {
    console.error("[cron/pipeline-auto-advance] query failed", selErr);
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }

  let closed = 0;
  for (const row of candidates ?? []) {
    const airDate = (row as unknown as { broadcast: { air_date: string } }).broadcast.air_date;
    const { error: updErr } = await sb
      .from("product_selections")
      .update({
        status: "closed",
        closed_reason: "aired",
        closed_at: `${airDate}T12:00:00+09:00`,
        closed_by: null,
      })
      .eq("id", row.id)
      .eq("status", "scheduled");
    if (updErr) {
      console.warn("[cron/pipeline-auto-advance] update failed:", updErr.message);
      continue;
    }
    await sb.from("product_selection_events").insert([
      { selection_id: row.id, event_type: "status_changed", from_status: "scheduled", to_status: "closed", is_system: true },
      { selection_id: row.id, event_type: "closed", closed_reason: "aired", is_system: true, note: "auto-closed by cron after broadcast air_date" },
    ]);
    closed++;
  }

  invalidateSelectionsAfterMutation("cron-auto-advance");
  return NextResponse.json({ ok: true, closed });
}
