"use client";
import { useState } from "react";
import { Copy, Download, Check } from "lucide-react";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface Props {
  markdown: string;
  title: string;
  versionLabel?: string;
  createdAt?: string;
}

function pad(n: number, w: number): string {
  return n.toString().padStart(w, "0");
}

function formatStamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1, 2)}.${pad(d.getDate(), 2)} · ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

export function ScreenplayViewer({ markdown, title, versionLabel, createdAt }: Props) {
  const [copied, setCopied] = useState(false);

  function downloadMd() {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}.md`;
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
      {/* document toolbar */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 bg-stone-50/95 backdrop-blur-sm border-b border-stone-200 px-6 py-2.5">
        <div className="flex items-baseline gap-4 font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 min-w-0">
          {versionLabel && <span className="text-stone-900 font-bold">{versionLabel}</span>}
          {createdAt && <span className="tabular-nums truncate">{formatStamp(createdAt)}</span>}
          <span className="tabular-nums">{chars.toLocaleString()} chars</span>
        </div>
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

      {/* paper */}
      <div className="bg-white border border-stone-200 border-t-0">
        <div className="px-10 py-12 lg:px-14 lg:py-14">
          <ScreenplayMarkdown markdown={markdown} />
        </div>
      </div>
    </div>
  );
}
