import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import type { BoardCard, BoardData, SelectionStatus } from "@/lib/selections/types";

export const maxDuration = 10;

const STATUSES: SelectionStatus[] = ["selected", "sourcing", "scheduled", "closed"];

const SELECT_STRING = `
  id, discovered_product_id, status, owner_id, assignee_id, broadcast_id,
  closed_reason, closed_at, closed_by, sourcing_note, scheduled_note,
  closed_note, created_at, updated_at,
  product:discovered_products!inner(
    name, thumbnail_url, price_jpy, category, source, tv_fit_score, product_url
  ),
  broadcast:broadcasts(channel, air_date, start_time, program_title),
  owner:profiles!product_selections_owner_id_fkey(display_name, email),
  assignee:profiles!product_selections_assignee_id_fkey(display_name, email)
`;

export async function GET(req: NextRequest) {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope"); // 'mine_owned' | 'mine_assigned' | null
  const assigneeFilter = url.searchParams.get("assignee");
  const q = url.searchParams.get("q");
  const includeClosed = url.searchParams.get("includeClosed") === "1";

  const { sb, user } = auth;

  // TODO: q filter on embedded product.name is not supported by Supabase JS client
  // (filter operators on embedded resources in select() require PostgREST >= 12 with
  // the `embedded-resource-filter` feature; supabase-js does not expose this).
  // For v1 the q param is accepted but not applied server-side; client should filter
  // the returned board data locally.
  void q;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runQuery(applyClosed: (q: any) => any) {
    let q = sb
      .from("product_selections")
      .select(SELECT_STRING)
      .order("updated_at", { ascending: false });
    q = applyClosed(q);
    if (scope === "mine_owned") q = q.eq("owner_id", user.id);
    if (scope === "mine_assigned") q = q.eq("assignee_id", user.id);
    if (assigneeFilter && assigneeFilter !== "all") q = q.eq("assignee_id", assigneeFilter);
    return q;
  }

  const active = await runQuery((q) => q.neq("status", "closed"));
  const closed = includeClosed
    ? await runQuery((q) => q.eq("status", "closed").gte("closed_at", sevenDaysAgo))
    : { data: [], error: null };

  if (active.error) {
    console.error("[selections/board] query failed", active.error);
    return NextResponse.json({ error: active.error.message }, { status: 500 });
  }
  if (closed.error) {
    console.error("[selections/board] query failed", closed.error);
    return NextResponse.json({ error: closed.error.message }, { status: 500 });
  }

  const rows = [...(active.data ?? []), ...(closed.data ?? [])];

  const board: BoardData = { selected: [], sourcing: [], scheduled: [], closed: [] };
  for (const row of rows) {
    const card = row as unknown as BoardCard;
    if (STATUSES.includes(card.status)) {
      board[card.status].push(card);
    } else {
      console.warn(`[selections/board] unknown status dropped: ${card.status} (id=${card.id})`);
    }
  }

  return NextResponse.json({ board });
}
