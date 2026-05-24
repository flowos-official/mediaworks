"use client";
import { useState } from "react";
import { MoreVertical } from "lucide-react";
import type { BoardCard } from "@/lib/selections/types";
import { EventsTimelineModal } from "./EventsTimelineModal";

export function CardMenu({ card, onChanged }: { card: BoardCard; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  async function reopen() {
    setOpen(false);
    const res = await fetch(`/api/selections/${card.id}/reopen`, { method: "POST" });
    if (!res.ok) {
      alert((await res.json()).error ?? "reopen failed");
      return;
    }
    onChanged();
  }

  async function close() {
    setOpen(false);
    const reason = window.prompt("종료 사유? (aired / dropped / postponed)", "dropped");
    if (!reason || !["aired", "dropped", "postponed"].includes(reason)) return;
    const res = await fetch(`/api/selections/${card.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_status: "closed", closed_reason: reason }),
    });
    if (!res.ok) {
      alert((await res.json()).error ?? "close failed");
      return;
    }
    onChanged();
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="p-1 hover:bg-muted rounded"
      >
        <MoreVertical size={14} />
      </button>
      {open && (
        <div className="absolute right-2 top-8 bg-popover border border-border rounded shadow-lg text-xs z-10 w-40">
          <button onClick={() => setHistoryOpen(true)} className="block w-full text-left px-3 py-1.5 hover:bg-muted">
            이력 보기
          </button>
          <a
            href={card.product.product_url}
            target="_blank" rel="noreferrer"
            className="block w-full text-left px-3 py-1.5 hover:bg-muted"
          >
            원본 상품 보기
          </a>
          {card.status === "closed"
            ? <button onClick={reopen} className="block w-full text-left px-3 py-1.5 hover:bg-muted">다시 소싱으로</button>
            : <button onClick={close} className="block w-full text-left px-3 py-1.5 hover:bg-muted text-red-600">종료 처리</button>}
        </div>
      )}
      {historyOpen && (
        <EventsTimelineModal selectionId={card.id} onClose={() => setHistoryOpen(false)} />
      )}
    </>
  );
}
