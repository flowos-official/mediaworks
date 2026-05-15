"use client";
import { useState } from "react";
import { ArrowRight } from "lucide-react";

interface Props {
  screenplayId: string;
  baseVersionId: string;
  disabled?: boolean;
  onStart: (runId: string) => void;
}

const SUGGESTIONS = [
  "実演デモを最後の方に移動してください。",
  "値段を見せる前に値引きの理由を一段重ねてください。",
  "お客様の声を3人に増やして、年代と職業を変えてください。",
  "この特徴説明を最後に入れてください。",
];

export function FeedbackForm({ screenplayId, baseVersionId, disabled, onStart }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const feedback = text.trim();
    if (!feedback) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/screenplays/${screenplayId}/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback, baseVersionId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "refine failed");
      onStart(j.runId as string);
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 mb-3">
        Director's Note
      </div>
      <div
        className="border border-stone-900"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to bottom, transparent, transparent 27px, rgb(228 228 231 / 0.6) 27px, rgb(228 228 231 / 0.6) 28px)",
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          disabled={disabled || busy}
          placeholder="例: 実演デモを最後に入れてください。お客様の声を3人に増やして、それぞれの職業を変えてください。"
          className="w-full bg-transparent px-4 py-2.5 text-[14px] leading-[28px] text-stone-900 placeholder:text-stone-400 focus:outline-none resize-none [font-family:var(--font-jp)]"
        />
      </div>

      <div className="mt-4">
        <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 mb-2">
          Quick Inserts
        </div>
        <div className="flex flex-col gap-px">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setText((t) => (t ? t + "\n" : "") + s)}
              className="text-left text-[12px] leading-relaxed px-3 py-2 border border-stone-200 bg-stone-50 hover:bg-stone-100 hover:border-stone-400 transition-colors text-stone-700 [font-family:var(--font-jp)]"
            >
              <span className="font-mono text-stone-400 mr-2 select-none">+</span>
              {s}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="mt-4 border border-stone-900 bg-stone-50 px-3 py-2 font-mono text-[10px] tracking-wider text-stone-900">
          NG / {err}
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={disabled || busy || !text.trim()}
        className="group mt-5 w-full inline-flex items-center justify-between gap-3 bg-stone-900 text-stone-50 pl-5 pr-4 py-3.5 hover:bg-stone-800 disabled:bg-stone-300 disabled:cursor-not-allowed transition-colors"
      >
        <span className="font-mono text-[11px] tracking-[0.3em] uppercase">
          {busy ? "Sending…" : "Reroll Take"}
        </span>
        <ArrowRight
          className={`h-4 w-4 transition-transform ${busy ? "" : "group-hover:translate-x-1"}`}
          strokeWidth={2}
        />
      </button>

      <div className="mt-4 font-mono text-[10px] tracking-[0.2em] text-stone-400 leading-relaxed">
        Tip · 「最後に」「もっと劇的に」「○人に増やして」のように、
        <span className="text-stone-700">具体的な要望</span>
        ほど改稿が安定します。
      </div>
    </div>
  );
}
