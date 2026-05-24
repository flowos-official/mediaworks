import { requireUser } from "@/lib/auth/require-user";
import type { BoardData, BoardCard } from "@/lib/selections/types";
import { KanbanBoard } from "@/components/pipeline/KanbanBoard";

export const dynamic = "force-dynamic";

// TODO(task-9): replace literal strings with getTranslations("pipeline") once the
// "pipeline" namespace is added to messages/ja.json and messages/en.json.
const TITLE = "商品選定パイプライン";
const SUBTITLE = "선택 → 소싱 → 방송예정 → 종료 흐름을 확인합니다";

async function loadBoard(
  sb: Extract<Awaited<ReturnType<typeof requireUser>>, { sb: unknown }>["sb"]
): Promise<BoardData> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const baseSelect = `
    id, discovered_product_id, status, owner_id, assignee_id, broadcast_id,
    closed_reason, closed_at, closed_by, sourcing_note, scheduled_note,
    closed_note, created_at, updated_at,
    product:discovered_products!inner(name, thumbnail_url, price_jpy, category, source, tv_fit_score, product_url),
    broadcast:broadcasts(channel, air_date, start_time, program_title),
    owner:profiles!product_selections_owner_id_fkey(display_name, email),
    assignee:profiles!product_selections_assignee_id_fkey(display_name, email)
  `;

  const [activeRes, closedRes] = await Promise.all([
    (sb as any).from("product_selections").select(baseSelect).neq("status", "closed").order("updated_at", { ascending: false }),
    (sb as any).from("product_selections").select(baseSelect).eq("status", "closed").gte("closed_at", sevenDaysAgo).order("closed_at", { ascending: false }),
  ]);

  const board: BoardData = { selected: [], sourcing: [], scheduled: [], closed: [] };
  const rows = [...((activeRes.data ?? []) as unknown as BoardCard[]), ...((closedRes.data ?? []) as unknown as BoardCard[])];
  for (const card of rows) {
    if (board[card.status]) board[card.status].push(card);
  }
  return board;
}

export default async function PipelinePage() {
  const auth = await requireUser(["viewer", "member", "admin"]);
  if ("error" in auth) return auth.error;

  const board = await loadBoard(auth.sb);
  const canWrite = auth.role !== "viewer";

  return (
    <main className="flex-1 p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">{TITLE}</h1>
        <p className="text-sm text-muted-foreground">{SUBTITLE}</p>
      </header>
      <KanbanBoard initialBoard={board} canWrite={canWrite} />
    </main>
  );
}
