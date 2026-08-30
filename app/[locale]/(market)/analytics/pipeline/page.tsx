import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { requireUser } from "@/lib/auth/require-user";
import { loadIntelligenceReadiness } from "@/lib/intelligence/readiness";
import type { BoardData, BoardCard } from "@/lib/selections/types";
import type { IntelligenceReadiness } from "@/lib/intelligence/readiness";
import { DataReadinessDashboard, type ReadinessDashboardCopy } from "@/components/pipeline/DataReadinessDashboard";
import { KanbanBoard } from "@/components/pipeline/KanbanBoard";

export const dynamic = "force-dynamic";

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
    sb.from("product_selections").select(baseSelect).neq("status", "closed").order("updated_at", { ascending: false }),
    sb.from("product_selections").select(baseSelect).eq("status", "closed").gte("closed_at", sevenDaysAgo).order("closed_at", { ascending: false }),
  ]);

  if (activeRes.error) console.warn("[pipeline/loadBoard] active query failed:", activeRes.error.message);
  if (closedRes.error) console.warn("[pipeline/loadBoard] closed query failed:", closedRes.error.message);

  const board: BoardData = { selected: [], sourcing: [], scheduled: [], closed: [] };
  const rows = [...((activeRes.data ?? []) as unknown as BoardCard[]), ...((closedRes.data ?? []) as unknown as BoardCard[])];
  for (const card of rows) {
    if (board[card.status]) board[card.status].push(card);
  }
  return board;
}

async function loadReadiness(
  sb: Extract<Awaited<ReturnType<typeof requireUser>>, { sb: unknown }>["sb"],
): Promise<IntelligenceReadiness | null> {
  try {
    return await loadIntelligenceReadiness(sb, new Date());
  } catch (err) {
    console.warn("[pipeline/loadReadiness] readiness unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}

export default async function PipelinePage() {
  const [t, locale, auth] = await Promise.all([
    getTranslations("pipeline"),
    getLocale(),
    requireUser(["viewer", "member", "admin"]),
  ]);
  if ("error" in auth) redirect(`/${locale}/login`);

  const canWrite = auth.role !== "viewer";

  // Read as the signed-in user so RLS decides what they see. The readiness
  // sources are Group B, so a viewer would only get errors out of the loader —
  // skip the call for them rather than branching inside the component.
  //
  // Readiness is also strictly secondary to the board: an operator opens this
  // page to work the kanban. A failing telemetry query must degrade the panel,
  // never take the board down with it.
  const [board, readiness] = await Promise.all([
    loadBoard(auth.sb),
    canWrite ? loadReadiness(auth.sb) : Promise.resolve(null),
  ]);

  return (
    <section className="space-y-5 lg:space-y-6">
      <header className="mw-panel px-4 py-4 sm:px-5">
        <div className="mw-kicker mb-1">{t("pageKicker")}</div>
        <h2 className="text-xl font-bold tracking-[-0.02em]">{t("pageTitle")}</h2>
        <p className="mt-1 text-xs text-muted-foreground sm:text-sm">{t("pageSubtitle")}</p>
      </header>

      {readiness ? (
        <DataReadinessDashboard
          readiness={readiness}
          copy={t.raw("readiness") as ReadinessDashboardCopy}
          locale={locale}
        />
      ) : null}

      <section aria-labelledby="selection-operations-title" className="space-y-3">
        <header className="flex flex-col gap-1 px-0.5 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div>
            <div className="mw-kicker mb-1">{t("boardKicker")}</div>
            <h2 id="selection-operations-title" className="mw-section-title">{t("boardTitle")}</h2>
          </div>
          <p className="text-xs text-muted-foreground sm:text-right">{t("subtitle")}</p>
        </header>
        <Suspense>
          <KanbanBoard initialBoard={board} canWrite={canWrite} />
        </Suspense>
      </section>
    </section>
  );
}
