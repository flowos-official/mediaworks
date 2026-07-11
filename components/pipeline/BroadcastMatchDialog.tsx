"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { BoardCard } from "@/lib/selections/types";
import { useDialogBehavior } from "@/components/ui/use-dialog-behavior";

type Suggestion = {
  id: string; channel: string; air_date: string; start_time: string | null;
  program_title: string; score: number;
};

interface Props {
  card: BoardCard;
  onConfirm: (broadcastId: string | null, note: string | null) => void | Promise<void>;
  onCancel: () => void;
}

export function BroadcastMatchDialog({ card, onConfirm, onCancel }: Props) {
  const t = useTranslations("pipeline");
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(true, onCancel, dialogRef);
  const [channel, setChannel] = useState("all");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [others, setOthers] = useState<Suggestion[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchCandidates() {
      setLoading(true);
      const from = new Date().toISOString().slice(0, 10);
      const toDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const q = new URLSearchParams({
        productName: card.product.name,
        channel,
        from,
        to: toDate,
      });
      try {
        const res = await fetch(`/api/selections/match-broadcast?${q}`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          setSuggestions(data.suggestions ?? []);
          setOthers(data.others ?? []);
        }
      } catch (err) {
        if (!cancelled) console.error("[BroadcastMatchDialog] fetch failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchCandidates();
    return () => { cancelled = true; };
  }, [card.product.name, channel]);

  function handleConfirm() {
    if (manualMode) {
      if (!note.trim()) return;
      onConfirm(null, note.trim());
      return;
    }
    if (!picked) return;
    onConfirm(picked, null);
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="broadcast-match-title" tabIndex={-1} className="bg-card rounded-xl border border-border shadow-xl max-w-2xl w-full max-h-[85dvh] flex flex-col">
        <header className="p-4 border-b border-border">
          <h2 id="broadcast-match-title" className="font-semibold">{t("matchTitle")}</h2>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{card.product.name}</p>
        </header>
        <div className="p-4 flex-1 overflow-auto">
          <label htmlFor="broadcast-match-channel" className="text-xs">{t("channel")}</label>
          <select
            id="broadcast-match-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="w-full text-sm border border-border rounded px-2 py-1 mb-3"
          >
            <option value="all">{t("allChannels")}</option>
            <option value="qvc">QVC</option>
            <option value="shopch">Shop Channel</option>
          </select>

          {!manualMode && (
            <>
              {loading && <p className="text-xs text-muted-foreground" role="status">{t("searching")}</p>}
              {!loading && suggestions.length > 0 && (
                <>
                  <p className="text-xs font-semibold mb-1">{t("suggestions")}</p>
                  {suggestions.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 p-2 border border-border rounded mb-1 cursor-pointer">
                      <input type="radio" name="bc" value={s.id}
                        checked={picked === s.id} onChange={() => setPicked(s.id)} />
                      <span className="text-xs">
                        <strong>{s.channel.toUpperCase()}</strong> · {s.air_date}
                        {s.start_time ? ` ${s.start_time}` : ""} · {s.program_title}
                      </span>
                    </label>
                  ))}
                </>
              )}
              {!loading && others.length > 0 && (
                <details className="mt-3">
                  <summary className="text-xs cursor-pointer">{t("allResults", { count: others.length })}</summary>
                  {others.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 p-2 border border-border rounded mb-1 cursor-pointer">
                      <input type="radio" name="bc" value={s.id}
                        checked={picked === s.id} onChange={() => setPicked(s.id)} />
                      <span className="text-xs">
                        <strong>{s.channel.toUpperCase()}</strong> · {s.air_date}
                        {s.start_time ? ` ${s.start_time}` : ""} · {s.program_title}
                      </span>
                    </label>
                  ))}
                </details>
              )}
            </>
          )}

          <label className="flex items-center gap-2 mt-4 text-xs">
            <input type="checkbox" checked={manualMode} onChange={(e) => setManualMode(e.target.checked)} />
            {t("manualSlot")}
          </label>
          {manualMode && (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-label={t("manualPlaceholder")}
              placeholder={t("manualPlaceholder")}
              rows={3}
              className="w-full mt-2 text-sm border border-border rounded px-2 py-1"
            />
          )}
        </div>
        <footer className="p-4 border-t border-border flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-border px-3 text-sm hover:bg-muted">
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={manualMode ? !note.trim() : !picked}
            className="min-h-10 rounded-lg bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
          >
            {t("confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}
