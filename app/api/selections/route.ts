import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import type { BoardCard, BoardData, SelectionStatus } from "@/lib/selections/types";

export const maxDuration = 10;

const STATUSES: SelectionStatus[] = ["selected", "sourcing", "scheduled", "closed"];

export async function GET(req: NextRequest) {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope"); // 'mine_owned' | 'mine_assigned' | null
  const assigneeFilter = url.searchParams.get("assignee");
  const q = url.searchParams.get("q");
  const includeClosed = url.searchParams.get("includeClosed") === "1";

  const sb = getServiceClient();

  // TODO: q filter on embedded product.name is not supported by Supabase JS client
  // (filter operators on embedded resources in select() require PostgREST >= 12 with
  // the `embedded-resource-filter` feature; supabase-js does not expose this).
  // For v1 the q param is accepted but not applied server-side; client should filter
  // the returned board data locally.

  let query = sb
    .from("product_selections")
    .select(`
      id, discovered_product_id, status, owner_id, assignee_id, broadcast_id,
      closed_reason, closed_at, closed_by, sourcing_note, scheduled_note,
      closed_note, created_at, updated_at,
      product:discovered_products!inner(
        name, thumbnail_url, price_jpy, category, source, tv_fit_score, product_url
      ),
      broadcast:broadcasts(channel, air_date, start_time, program_title),
      owner:profiles!product_selections_owner_id_fkey(display_name, email),
      assignee:profiles!product_selections_assignee_id_fkey(display_name, email)
    `)
    .order("updated_at", { ascending: false });

  if (!includeClosed) {
    query = query.neq("status", "closed");
  } else {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    query = query.or(`status.neq.closed,and(status.eq.closed,closed_at.gte.${sevenDaysAgo})`);
  }

  if (scope === "mine_owned") query = query.eq("owner_id", auth.user.id);
  if (scope === "mine_assigned") query = query.eq("assignee_id", auth.user.id);
  if (assigneeFilter && assigneeFilter !== "all") query = query.eq("assignee_id", assigneeFilter);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const board: BoardData = { selected: [], sourcing: [], scheduled: [], closed: [] };
  for (const row of data ?? []) {
    const card = row as unknown as BoardCard;
    if (STATUSES.includes(card.status)) board[card.status].push(card);
  }

  return NextResponse.json({ board });
}
