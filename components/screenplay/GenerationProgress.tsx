// components/screenplay/GenerationProgress.tsx
"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import type { ProgressEvent } from "@/lib/screenplay/types";

interface Props {
  runId: string;
  onComplete: (versionId: string, versionNumber: number) => void;
}

export function GenerationProgress({ runId, onComplete }: Props) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<{ versionId: string; versionNumber: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function consume() {
      try {
        const res = await fetch(`/api/screenplays/run/${runId}/stream`, { signal: controller.signal });
        if (!res.body) throw new Error("no stream body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
              const ev = JSON.parse(t) as ProgressEvent;
              if (cancelled) return;
              setEvents((prev) => [...prev, ev]);
              if (ev.type === "done") {
                setDoneAt({ versionId: ev.versionId, versionNumber: ev.versionNumber });
                onComplete(ev.versionId, ev.versionNumber);
              } else if (ev.type === "error") {
                setError(ev.message);
              }
            } catch {
              // ignore malformed lines
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        try {
          for (let i = 0; i < 60 && !cancelled; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            const sr = await fetch(`/api/screenplays/run/${runId}/status`);
            if (!sr.ok) continue;
            const sj = (await sr.json()) as { status: string; returnValue?: { versionId: string; versionNumber: number } };
            if (sj.status === "completed" && sj.returnValue) {
              setDoneAt({ versionId: sj.returnValue.versionId, versionNumber: sj.returnValue.versionNumber });
              onComplete(sj.returnValue.versionId, sj.returnValue.versionNumber);
              return;
            }
            if (sj.status === "failed") {
              setError("workflow failed");
              return;
            }
          }
          setError(`stream lost: ${msg}`);
        } catch (fallbackErr) {
          setError(`stream lost: ${msg} / fallback failed: ${fallbackErr}`);
        }
      }
    }

    void consume();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runId, onComplete]);

  const lastChunk = [...events].reverse().find((e) => e.type === "chunk") as { type: "chunk"; chars: number } | undefined;
  const lastStep = [...events].reverse().find((e) => e.type === "step") as { type: "step"; name: string; status: string } | undefined;

  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-4 flex items-start gap-3">
      {error ? (
        <AlertTriangle className="h-5 w-5 text-zinc-700 mt-0.5" />
      ) : doneAt ? (
        <CheckCircle2 className="h-5 w-5 text-zinc-700 mt-0.5" />
      ) : (
        <Loader2 className="h-5 w-5 animate-spin text-zinc-700 mt-0.5" />
      )}
      <div className="text-sm text-zinc-800">
        {error ? (
          <div>失敗しました: {error}</div>
        ) : doneAt ? (
          <div>バージョン v{doneAt.versionNumber} を生成しました。</div>
        ) : (
          <>
            <div className="font-medium">台本を生成中…（Gemini 3.1 Pro, HIGH thinking）</div>
            {lastStep && <div className="text-xs text-zinc-500">step: {lastStep.name} ({lastStep.status})</div>}
            {lastChunk && <div className="text-xs text-zinc-500">streamed {lastChunk.chars.toLocaleString()} 文字</div>}
          </>
        )}
      </div>
    </div>
  );
}
