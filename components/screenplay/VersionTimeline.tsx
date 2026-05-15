"use client";
import type { ScreenplayVersionRow } from "@/lib/screenplay/types";

interface Props {
  versions: Pick<ScreenplayVersionRow, "id" | "version_number" | "feedback" | "created_at">[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function pad(n: number, w: number): string {
  return n.toString().padStart(w, "0");
}

function relative(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function VersionTimeline({ versions, selectedId, onSelect }: Props) {
  // newest first reads better in a revision sidebar
  const ordered = [...versions].reverse();
  return (
    <ol className="relative">
      <span aria-hidden className="absolute left-[10px] top-2 bottom-2 w-px bg-stone-300" />
      {ordered.map((v) => {
        const active = v.id === selectedId;
        return (
          <li key={v.id} className="relative pl-7">
            <button
              type="button"
              onClick={() => onSelect(v.id)}
              className={`w-full text-left py-3 pr-3 -mr-3 transition-colors ${active ? "" : "hover:bg-stone-100"}`}
            >
              <span
                aria-hidden
                className={`absolute left-[6px] top-[18px] h-2.5 w-2.5 rounded-full border-2 ${active ? "border-stone-900 bg-stone-900" : "border-stone-400 bg-stone-50"}`}
              />
              <div className="flex items-baseline justify-between gap-2">
                <span className={`font-mono text-xs font-bold tabular-nums tracking-widest ${active ? "text-stone-900" : "text-stone-500"}`}>
                  V{pad(v.version_number, 2)}
                </span>
                <span className="font-mono text-[10px] text-stone-400 tabular-nums">{relative(v.created_at)}</span>
              </div>
              <div className={`mt-1 text-xs leading-relaxed line-clamp-3 ${active ? "text-stone-900" : "text-stone-500"}`}>
                {v.feedback ? (
                  <span className="border-l-2 border-stone-300 pl-2 italic">{v.feedback}</span>
                ) : (
                  <span className="font-mono text-[10px] tracking-[0.25em] uppercase">Initial Draft</span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
