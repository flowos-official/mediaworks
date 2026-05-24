"use client";
import { useEffect, useState } from "react";

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

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/selections/${selectionId}/events`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setEvents(d.events ?? []); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectionId]);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl shadow-xl max-w-lg w-full max-h-[70vh] flex flex-col">
        <header className="p-4 border-b border-border flex justify-between">
          <h2 className="font-semibold">이력</h2>
          <button onClick={onClose} className="text-sm">닫기</button>
        </header>
        <ol className="p-4 overflow-auto text-xs space-y-2">
          {loading && <li className="text-muted-foreground">로딩 중…</li>}
          {!loading && events.length === 0 && <li className="text-muted-foreground italic">이력 없음</li>}
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
