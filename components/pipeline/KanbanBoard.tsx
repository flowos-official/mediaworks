"use client";
import { useState } from "react";
import type { BoardData, SelectionStatus } from "@/lib/selections/types";
import { SelectionCard } from "./SelectionCard";

const COLUMNS: Array<{ status: SelectionStatus; tone: string }> = [
  { status: "selected", tone: "bg-neutral-100 dark:bg-neutral-900/40" },
  { status: "sourcing", tone: "bg-amber-100 dark:bg-amber-900/30" },
  { status: "scheduled", tone: "bg-blue-100 dark:bg-blue-900/30" },
  { status: "closed", tone: "bg-emerald-100 dark:bg-emerald-900/30" },
];

const LABELS: Record<SelectionStatus, string> = {
  selected: "선택됨",
  sourcing: "소싱중",
  scheduled: "방송예정",
  closed: "종료(최근 7일)",
};

export function KanbanBoard({
  initialBoard,
  canWrite,
}: {
  initialBoard: BoardData;
  canWrite: boolean;
}) {
  const [board] = useState<BoardData>(initialBoard);

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {COLUMNS.map((col) => (
        <section key={col.status} className={`rounded-xl p-3 ${col.tone}`}>
          <header className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">{LABELS[col.status]}</h2>
            <span className="text-xs text-muted-foreground">{board[col.status].length}</span>
          </header>
          <div className="flex flex-col gap-2">
            {board[col.status].map((card) => (
              <SelectionCard key={card.id} card={card} canWrite={canWrite} />
            ))}
            {board[col.status].length === 0 && (
              <p className="text-xs text-muted-foreground italic py-4 text-center">
                비어 있음
              </p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
