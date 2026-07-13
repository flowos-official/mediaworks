"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ArrowRight, PackageSearch } from "lucide-react";
import {
  DndContext, DragEndEvent, useDroppable, useDraggable, KeyboardSensor, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import type { BoardData, BoardCard, SelectionStatus } from "@/lib/selections/types";
import { SelectionCard } from "./SelectionCard";
import { BroadcastMatchDialog } from "./BroadcastMatchDialog";
import { localePath } from "@/lib/i18n/locale-path";
import { invalidateApiCache } from "@/lib/client/api-cache";

const COLUMNS: Array<{ status: SelectionStatus; tone: string }> = [
  { status: "selected",  tone: "border-t-slate-400" },
  { status: "sourcing",  tone: "border-t-amber-500" },
  { status: "scheduled", tone: "border-t-blue-500" },
  { status: "closed",    tone: "border-t-emerald-500" },
];

const VALID: Record<SelectionStatus, SelectionStatus[]> = {
  selected:  ["sourcing", "closed"],
  sourcing:  ["selected", "scheduled", "closed"],
  scheduled: ["sourcing", "closed"],
  closed:    [],
};

function DropColumn({ status, children, count, tone, label }: {
  status: SelectionStatus; children: React.ReactNode; count: number; tone: string; label: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  return (
    <section
      ref={setNodeRef}
      className={`min-w-[260px] flex-1 rounded-xl border border-border border-t-2 bg-card p-3 shadow-sm ${tone} ${isOver ? "ring-2 ring-primary/55" : ""}`}
    >
      <header className="mb-3 flex items-center justify-between border-b border-border pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.04em]">{label}</h2>
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{count}</span>
      </header>
      <div className="flex flex-col gap-2 min-h-[40px]">{children}</div>
    </section>
  );
}

function DragCard({ card, canWrite, onChanged }: { card: BoardCard; canWrite: boolean; onChanged?: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id, disabled: !canWrite,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.5 : 1 }
    : undefined;
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <SelectionCard card={card} canWrite={canWrite} onChanged={onChanged} />
    </div>
  );
}

export function KanbanBoard({
  initialBoard, canWrite,
}: { initialBoard: BoardData; canWrite: boolean }) {
  const [board, setBoard] = useState(initialBoard);
  const t = useTranslations("pipeline");
  const locale = useLocale();
  const router = useRouter();
  const [pendingMove, setPendingMove] = useState<{
    card: BoardCard; from: SelectionStatus; to: SelectionStatus;
  } | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const previousBoard = useRef<BoardData>(initialBoard);

  const params = useSearchParams();
  const focus = params.get("focus");

  useEffect(() => {
    if (!focus) return;
    const el = document.querySelector<HTMLElement>(`[data-selection-id="${focus}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-indigo-400");
    const t = setTimeout(() => el.classList.remove("ring-2", "ring-indigo-400"), 1500);
    return () => clearTimeout(t);
  }, [focus]);

  async function refresh() {
    try {
      const res = await fetch("/api/selections");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBoard(data.board);
      setOperationError(null);
    } catch (error) {
      setOperationError(t("refreshFailed", { error: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async function performMove(card: BoardCard, to: SelectionStatus, extras: Record<string, unknown> = {}) {
    previousBoard.current = board;
    setOperationError(null);
    setBoard((b) => {
      const next: BoardData = { ...b };
      next[card.status] = b[card.status].filter((c) => c.id !== card.id);
      next[to] = [{ ...card, status: to }, ...b[to]];
      return next;
    });
    try {
      const res = await fetch(`/api/selections/${card.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_status: to, ...extras }),
      });
      if (res.ok) {
        await invalidateApiCache('/api/selections', '/api/discovery/');
        router.refresh();
        return;
      }
      const err = await res.json().catch(() => ({ error: "unknown" }));
      throw new Error(err.error ?? "unknown");
    } catch (error) {
      setBoard(previousBoard.current);
      setOperationError(t("moveFailed", { error: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async function onDragEnd(e: DragEndEvent) {
    if (!e.over) return;
    const colId = String(e.over.id);
    if (!colId.startsWith("col:")) return;
    const to = colId.slice(4) as SelectionStatus;
    const card = (Object.values(board).flat() as BoardCard[]).find((c) => c.id === e.active.id);
    if (!card) return;
    if (card.status === to) return;
    if (!VALID[card.status].includes(to)) {
      alert(t("moveNotAllowed", { from: t(`status.${card.status}`), to: t(`status.${to}`) }));
      return;
    }
    if (to === "scheduled") {
      setPendingMove({ card, from: card.status, to });
      return;
    }
    if (to === "closed") {
      const reason = window.prompt(
        t("closePrompt"),
        "dropped",
      );
      if (!reason || !["aired", "dropped", "postponed"].includes(reason)) return;
      await performMove(card, to, { closed_reason: reason });
      return;
    }
    await performMove(card, to);
  }

  const totalCards = Object.values(board).reduce((sum, cards) => sum + cards.length, 0);

  if (totalCards === 0) {
    return (
      <div className="mw-panel flex min-h-72 flex-col items-center justify-center px-5 py-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary"><PackageSearch size={22} /></div>
        <h2 className="mt-4 text-lg font-semibold text-foreground">{t("emptyTitle")}</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{canWrite ? t("emptyHint") : t("emptyViewerHint")}</p>
        {canWrite && (
          <Link href={localePath(locale, "/analytics/discovery")} className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
            {t("emptyAction")} <ArrowRight size={15} />
          </Link>
        )}
      </div>
    );
  }

  return (
    <>
      {operationError && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:text-red-300">
          <span>{operationError}</span>
          <button type="button" onClick={() => setOperationError(null)} className="font-medium underline">OK</button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        onDragEnd={onDragEnd}
        accessibility={{ screenReaderInstructions: { draggable: t("dragInstructions") } }}
      >
        <p className="mb-2 text-[10px] text-muted-foreground xl:hidden">↔ {t("mobileScrollHint")}</p>
        <div className="mw-scrollbar flex gap-3 overflow-x-auto pb-2 xl:grid xl:grid-cols-4 xl:overflow-visible">
          {COLUMNS.map((col) => (
            <DropColumn
              key={col.status}
              status={col.status}
              count={board[col.status].length}
              tone={col.tone}
              label={col.status === "closed" ? t("status.closedRecent") : t(`status.${col.status}`)}
            >
              {board[col.status].map((c) => (
                <DragCard key={c.id} card={c} canWrite={canWrite} onChanged={refresh} />
              ))}
              {board[col.status].length === 0 && (
                <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">{t("empty")}</p>
              )}
            </DropColumn>
          ))}
        </div>
      </DndContext>
      {pendingMove && (
        <BroadcastMatchDialog
          card={pendingMove.card}
          onCancel={() => setPendingMove(null)}
          onConfirm={async (broadcastId, note) => {
            const card = pendingMove.card;
            setPendingMove(null);
            await performMove(card, "scheduled", { broadcast_id: broadcastId, scheduled_note: note });
          }}
        />
      )}
    </>
  );
}
