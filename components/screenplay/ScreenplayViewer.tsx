"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface Props {
  markdown: string;
  title: string;
}

export function ScreenplayViewer({ markdown, title }: Props) {
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

  return (
    <div>
      <div className="flex items-center justify-end gap-2 mb-3 text-sm">
        <button type="button" onClick={copyMd} className="px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50 transition-colors">
          {copied ? "コピー済み" : "Markdown コピー"}
        </button>
        <button type="button" onClick={downloadMd} className="px-3 py-1 border border-zinc-300 rounded hover:bg-zinc-50 transition-colors inline-flex items-center gap-1">
          <Download className="h-3.5 w-3.5" /> .md ダウンロード
        </button>
      </div>
      <ScreenplayMarkdown markdown={markdown} />
    </div>
  );
}
