"use client";
import { Check, FileText } from "lucide-react";
import type { ScreenplayVersionRow } from "@/lib/screenplay/types";

interface Props {
  versions: Pick<ScreenplayVersionRow, "id" | "version_number" | "feedback" | "created_at">[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function VersionTimeline({ versions, selectedId, onSelect }: Props) {
  return (
    <ol className="space-y-2">
      {versions.map((v) => {
        const active = v.id === selectedId;
        return (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => onSelect(v.id)}
              className={`w-full text-left rounded border px-3 py-2 flex gap-3 items-start transition-colors ${active ? "border-zinc-900 bg-zinc-900 text-zinc-50" : "border-zinc-200 bg-white hover:border-zinc-400"}`}
            >
              <div className="mt-0.5">
                {active ? <Check className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold">v{v.version_number}</div>
                <div className={`text-xs truncate ${active ? "text-zinc-300" : "text-zinc-500"}`}>
                  {v.feedback ? `「${v.feedback}」` : "初回生成"}
                </div>
                <div className={`text-[10px] ${active ? "text-zinc-400" : "text-zinc-400"}`}>
                  {new Date(v.created_at).toLocaleString("ja-JP")}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
