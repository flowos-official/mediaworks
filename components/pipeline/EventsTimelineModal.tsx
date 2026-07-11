"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useDialogBehavior } from "@/components/ui/use-dialog-behavior";

type EventRow = {
  id: string; event_type: string; from_status: string | null; to_status: string | null;
  closed_reason: string | null; note: string | null; is_system: boolean; created_at: string;
  actor: { display_name: string | null; email: string } | null;
};

export function EventsTimelineModal({
  selectionId, onClose,
}: { selectionId: string; onClose: () => void }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const t = useTranslations("pipeline");
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(true, onClose, dialogRef);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/selections/${selectionId}/events`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setEvents(d.events ?? []); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectionId]);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="events-timeline-title" tabIndex={-1} className="bg-card rounded-xl border border-border shadow-xl max-w-lg w-full max-h-[75dvh] flex flex-col">
        <header className="p-4 border-b border-border flex justify-between">
          <h2 id="events-timeline-title" className="font-semibold">{t("historyTitle")}</h2>
          <button type="button" onClick={onClose} className="min-h-9 rounded-lg px-3 text-sm hover:bg-muted">{t("cancel")}</button>
        </header>
        <ol className="p-4 overflow-auto text-xs space-y-2">
          {loading && <li className="text-muted-foreground" role="status">{t("historyLoading")}</li>}
          {!loading && events.length === 0 && <li className="text-muted-foreground italic">{t("historyEmpty")}</li>}
          {!loading && events.map((e) => (
            <li key={e.id} className="border-l-2 border-border pl-3">
              <div className="text-muted-foreground">
                {new Date(e.created_at).toLocaleString()} ·{" "}
                {e.is_system ? "system" : (e.actor?.display_name ?? e.actor?.email ?? "?")}
              </div>
              <div>
                <strong>{e.event_type}</strong>
                {e.from_status && e.to_status && (
                  <span className="ml-1">({e.from_status} → {e.to_status})</span>
                )}
                {e.closed_reason && <span className="ml-1 text-red-600">[{e.closed_reason}]</span>}
              </div>
              {e.note && <div className="text-muted-foreground italic mt-0.5">{e.note}</div>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
