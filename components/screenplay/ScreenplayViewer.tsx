"use client";
import { useState } from "react";
import { Copy, Download, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface Props {
  markdown: string;
  title: string;
  versionLabel?: string;
  createdAt?: string;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  prevLabel?: string;
  nextLabel?: string;
}

function pad(n: number, w: number): string {
  return n.toString().padStart(w, "0");
}

function formatStamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1, 2)}.${pad(d.getDate(), 2)} · ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

export function ScreenplayViewer({
  markdown,
  title,
  versionLabel,
  createdAt,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
}: Props) {
  const [copied, setCopied] = useState(false);

  function downloadMd() {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}${versionLabel ? `-${versionLabel}` : ""}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyMd() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const chars = markdown.length;

  return (
    <div className="bg-stone-50">
      <div className="sticky top-0 z-10 grid grid-cols-[auto_1fr_auto] items-center gap-4 bg-stone-50/95 backdrop-blur-sm border-b border-stone-200 px-6 py-2">
        {/* Version navigation cluster */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrev}
            disabled={!hasPrev}
            title={prevLabel ? `Previous · ${prevLabel}` : "Previous version"}
            className="inline-flex items-center gap-1 px-2 py-1.5 font-mono text-[10px] tracking-[0.2em] uppercase text-stone-700 hover:text-stone-900 hover:bg-stone-100 disabled:text-stone-300 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="h-3 w-3" strokeWidth={2} />
            Prev
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!hasNext}
            title={nextLabel ? `Next · ${nextLabel}` : "Next version"}
            className="inline-flex items-center gap-1 px-2 py-1.5 font-mono text-[10px] tracking-[0.2em] uppercase text-stone-700 hover:text-stone-900 hover:bg-stone-100 disabled:text-stone-300 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            Next
            <ChevronRight className="h-3 w-3" strokeWidth={2} />
          </button>
        </div>

        {/* Version stamp */}
        <div className="flex items-baseline gap-3 font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 min-w-0 overflow-hidden">
          {versionLabel && <span className="text-stone-900 font-bold">{versionLabel}</span>}
          {createdAt && <span className="tabular-nums truncate">{formatStamp(createdAt)}</span>}
          <span className="tabular-nums hidden sm:inline">{chars.toLocaleString()} chars</span>
        </div>

        {/* Export cluster */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyMd}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] tracking-[0.2em] uppercase text-stone-700 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            {copied ? <Check className="h-3 w-3" strokeWidth={2} /> : <Copy className="h-3 w-3" strokeWidth={1.5} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={downloadMd}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] tracking-[0.2em] uppercase text-stone-700 hover:text-stone-900 hover:bg-stone-100 transition-colors"
          >
            <Download className="h-3 w-3" strokeWidth={1.5} />
            .md
          </button>
        </div>
      </div>

      <div className="bg-white border border-stone-200 border-t-0">
        <div className="px-10 py-12 lg:px-14 lg:py-14">
          <ScreenplayMarkdown markdown={markdown} />
        </div>
      </div>
    </div>
  );
}
