"use client";
import { useState } from "react";
import { MoreVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import type { BoardCard } from "@/lib/selections/types";
import { EventsTimelineModal } from "./EventsTimelineModal";
import { invalidateApiCache } from "@/lib/client/api-cache";

export function CardMenu({ card, onChanged }: { card: BoardCard; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const t = useTranslations("pipeline");

  async function reopen() {
    setOpen(false);
    const res = await fetch(`/api/selections/${card.id}/reopen`, { method: "POST" });
    if (!res.ok) {
      alert((await res.json()).error ?? "reopen failed");
      return;
    }
    await invalidateApiCache('/api/selections', '/api/discovery/');
    onChanged();
  }

  async function close() {
    setOpen(false);
    const reason = window.prompt(t("closePrompt"), "dropped");
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
    await invalidateApiCache('/api/selections', '/api/discovery/');
    onChanged();
  }

  return (
    <>
      <button
        type="button"
        aria-label={t("cardMenu")}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-muted"
      >
        <MoreVertical size={14} />
      </button>
      {open && (
        <div role="menu" className="absolute right-2 top-11 bg-popover border border-border rounded-lg shadow-lg text-xs z-10 w-44 p-1">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setHistoryOpen(true); }} className="block min-h-9 w-full rounded-md px-3 text-left hover:bg-muted">
            {t("history")}
          </button>
          <a
            href={card.product.product_url}
            target="_blank" rel="noreferrer"
            role="menuitem"
            className="flex min-h-9 w-full items-center rounded-md px-3 text-left hover:bg-muted"
          >
            {t("sourceProduct")}
          </a>
          {card.status === "closed"
            ? <button type="button" role="menuitem" onClick={reopen} className="block min-h-9 w-full rounded-md px-3 text-left hover:bg-muted">{t("reopen")}</button>
            : <button type="button" role="menuitem" onClick={close} className="block min-h-9 w-full rounded-md px-3 text-left text-red-600 hover:bg-muted">{t("close")}</button>}
        </div>
      )}
      {historyOpen && (
        <EventsTimelineModal selectionId={card.id} onClose={() => setHistoryOpen(false)} />
      )}
    </>
  );
}
