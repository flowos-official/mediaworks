import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";

export const maxDuration = 5;

export async function GET() {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;

  const sb = auth.sb;
  const { data, error } = await sb
    .from("product_selections")
    .select("status")
    .neq("status", "closed");
  if (error) {
    console.error("[selections/counts] query failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts = { selected: 0, sourcing: 0, scheduled: 0, total: 0 };
  for (const row of data ?? []) {
    counts.total++;
    if (row.status === "selected") counts.selected++;
    else if (row.status === "sourcing") counts.sourcing++;
    else if (row.status === "scheduled") counts.scheduled++;
  }
  return NextResponse.json({ counts });
}
