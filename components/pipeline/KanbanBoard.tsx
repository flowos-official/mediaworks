"use client";
import { useState, useRef } from "react";
import {
  DndContext, DragEndEvent, useDroppable, useDraggable, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import type { BoardData, BoardCard, SelectionStatus } from "@/lib/selections/types";
import { SelectionCard } from "./SelectionCard";
import { BroadcastMatchDialog } from "./BroadcastMatchDialog";

const COLUMNS: Array<{ status: SelectionStatus; tone: string }> = [
  { status: "selected",  tone: "bg-neutral-100 dark:bg-neutral-900/40" },
  { status: "sourcing",  tone: "bg-amber-100 dark:bg-amber-900/30" },
  { status: "scheduled", tone: "bg-blue-100 dark:bg-blue-900/30" },
  { status: "closed",    tone: "bg-emerald-100 dark:bg-emerald-900/30" },
];

const LABELS: Record<SelectionStatus, string> = {
  selected: "선택됨", sourcing: "소싱중", scheduled: "방송예정", closed: "종료(최근 7일)",
};

const VALID: Record<SelectionStatus, SelectionStatus[]> = {
  selected:  ["sourcing", "closed"],
  sourcing:  ["selected", "scheduled", "closed"],
  scheduled: ["sourcing", "closed"],
  closed:    [],
};

function DropColumn({ status, children, count, tone }: {
  status: SelectionStatus; children: React.ReactNode; count: number; tone: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  return (
    <section
      ref={setNodeRef}
      className={`rounded-xl p-3 ${tone} ${isOver ? "ring-2 ring-indigo-400" : ""}`}
    >
      <header className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">{LABELS[status]}</h2>
        <span className="text-xs text-muted-foreground">{count}</span>
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
  const [pendingMove, setPendingMove] = useState<{
    card: BoardCard; from: SelectionStatus; to: SelectionStatus;
  } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const previousBoard = useRef<BoardData>(initialBoard);

  async function refresh() {
    try {
      const res = await fetch("/api/selections");
      if (res.ok) {
        const data = await res.json();
        setBoard(data.board);
      }
    } catch {}
  }

  async function performMove(card: BoardCard, to: SelectionStatus, extras: Record<string, unknown> = {}) {
    previousBoard.current = board;
    setBoard((b) => {
      const next: BoardData = { ...b };
      next[card.status] = b[card.status].filter((c) => c.id !== card.id);
      next[to] = [{ ...card, status: to }, ...b[to]];
      return next;
    });
    const res = await fetch(`/api/selections/${card.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_status: to, ...extras }),
    });
    if (!res.ok) {
      setBoard(previousBoard.current);
      const err = await res.json().catch(() => ({ error: "unknown" }));
      alert(`이동 실패: ${err.error}`);
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
      alert(`${card.status} → ${to} 이동은 불가능합니다.`);
      return;
    }
    if (to === "scheduled") {
      setPendingMove({ card, from: card.status, to });
      return;
    }
    if (to === "closed") {
      const reason = window.prompt(
        "종료 사유? (aired / dropped / postponed)",
        "dropped",
      );
      if (!reason || !["aired", "dropped", "postponed"].includes(reason)) return;
      await performMove(card, to, { closed_reason: reason });
      return;
    }
    await performMove(card, to);
  }

  return (
    <>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {COLUMNS.map((col) => (
            <DropColumn key={col.status} status={col.status} count={board[col.status].length} tone={col.tone}>
              {board[col.status].map((c) => (
                <DragCard key={c.id} card={c} canWrite={canWrite} onChanged={refresh} />
              ))}
              {board[col.status].length === 0 && (
                <p className="text-xs text-muted-foreground italic py-4 text-center">비어 있음</p>
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
