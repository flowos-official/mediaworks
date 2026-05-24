"use client";
import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/selections/types";

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
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <header className="p-4 border-b border-border">
          <h2 className="font-semibold">방송 슬롯 연결</h2>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{card.product.name}</p>
        </header>
        <div className="p-4 flex-1 overflow-auto">
          <label className="text-xs">채널</label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="w-full text-sm border border-border rounded px-2 py-1 mb-3"
          >
            <option value="all">전체</option>
            <option value="qvc">QVC</option>
            <option value="shopch">Shop Channel</option>
          </select>

          {!manualMode && (
            <>
              {loading && <p className="text-xs text-muted-foreground">검색 중…</p>}
              {!loading && suggestions.length > 0 && (
                <>
                  <p className="text-xs font-semibold mb-1">추천 후보</p>
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
                  <summary className="text-xs cursor-pointer">전체 결과 ({others.length})</summary>
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
            broadcasts 테이블에 없는 슬롯 — 수동 입력
          </label>
          {manualMode && (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="채널, 일시, 메모 등을 자유롭게 입력하세요"
              rows={3}
              className="w-full mt-2 text-sm border border-border rounded px-2 py-1"
            />
          )}
        </div>
        <footer className="p-4 border-t border-border flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm border border-border rounded">
            취소
          </button>
          <button
            onClick={handleConfirm}
            disabled={manualMode ? !note.trim() : !picked}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded disabled:opacity-50"
          >
            확정
          </button>
        </footer>
      </div>
    </div>
  );
}
