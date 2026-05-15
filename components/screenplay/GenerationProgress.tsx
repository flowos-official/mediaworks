// components/screenplay/GenerationProgress.tsx
"use client";

import { useEffect, useState } from "react";
import type { ProgressEvent } from "@/lib/screenplay/types";

interface Props {
  runId: string;
  onComplete: (versionId: string, versionNumber: number) => void;
}

export function GenerationProgress({ runId, onComplete }: Props) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<{ versionId: string; versionNumber: number } | null>(null);
  const [startedAt] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (doneAt || error) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [doneAt, error]);

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
              // ignore
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
  const elapsedSec = Math.floor((now - startedAt) / 1000);
  const min = Math.floor(elapsedSec / 60).toString().padStart(2, "0");
  const sec = (elapsedSec % 60).toString().padStart(2, "0");
  const chars = lastChunk?.chars ?? 0;
  // we expect ~30-60K final chars; cap progress at 95% until "done"
  const pctTarget = error ? 0 : doneAt ? 100 : Math.min(95, Math.floor((chars / 45000) * 100));

  const state: "rolling" | "done" | "ng" = error ? "ng" : doneAt ? "done" : "rolling";
  const stateLabel = error ? "NG" : doneAt ? "TAKE" : "ROLLING";

  return (
    <div className="border border-stone-900 bg-white">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-stone-200">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            state === "rolling" ? "bg-stone-900 animate-pulse" : state === "done" ? "bg-stone-900" : "border border-stone-900"
          }`}
        />
        <span className="font-mono text-[10px] font-bold tracking-[0.3em] uppercase text-stone-900">
          {stateLabel}
        </span>
        <span className="font-mono text-[10px] tracking-[0.25em] uppercase text-stone-400">·</span>
        <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-stone-500">
          Gemini 3 Flash · Thinking Low
        </span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-stone-700">
          {min}:{sec}
        </span>
      </div>

      <div className="px-4 py-4">
        <div className="grid grid-cols-3 gap-4 font-mono text-[10px] tracking-[0.2em] uppercase text-stone-500">
          <div>
            <div className="text-stone-400">Step</div>
            <div className="text-stone-900 mt-1 tracking-wider">
              {lastStep ? `${lastStep.name} · ${lastStep.status}` : "queued"}
            </div>
          </div>
          <div>
            <div className="text-stone-400">Streamed</div>
            <div className="text-stone-900 mt-1 tabular-nums">{chars.toLocaleString().padStart(5, "0")} chars</div>
          </div>
          <div>
            <div className="text-stone-400">Progress</div>
            <div className="text-stone-900 mt-1 tabular-nums">{pctTarget.toString().padStart(2, "0")}%</div>
          </div>
        </div>

        <div className="mt-4 h-1 bg-stone-100 relative overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-stone-900 transition-[width] duration-700 ease-out"
            style={{ width: `${pctTarget}%` }}
          />
        </div>

        {error && (
          <div className="mt-3 font-mono text-[11px] tracking-wide text-stone-900">
            <span className="text-stone-500">err:</span> {error}
          </div>
        )}
        {doneAt && (
          <div className="mt-3 font-mono text-[11px] tracking-wider uppercase text-stone-700">
            v{doneAt.versionNumber.toString().padStart(2, "0")} ready
          </div>
        )}
      </div>
    </div>
  );
}
