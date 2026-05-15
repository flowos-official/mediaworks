"use client";
import { useState } from "react";
import { Send } from "lucide-react";

interface Props {
  screenplayId: string;
  baseVersionId: string;
  disabled?: boolean;
  onStart: (runId: string) => void;
}

const SUGGESTIONS = [
  "実演デモを最後の方に移動してください。",
  "価格発表をもっと劇的に。値段を見せる前に値引きの理由を一段重ねてください。",
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
    <div className="rounded border border-zinc-200 bg-white p-4">
      <label className="text-sm font-bold block mb-2">フィードバックを入力して改稿</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        disabled={disabled || busy}
        placeholder="例: 実演デモを最後に入れてください。お客様の声を3人に増やして、それぞれの職業を変えてください。"
        className="w-full border border-zinc-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-900"
      />
      <div className="flex flex-wrap gap-2 mt-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setText((t) => (t ? t + "\n" : "") + s)}
            className="text-xs px-2 py-1 border border-zinc-200 rounded hover:bg-zinc-50 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
      {err && <div className="text-xs text-zinc-700 mt-2">{err}</div>}
      <div className="flex justify-end mt-3">
        <button
          type="button"
          onClick={submit}
          disabled={disabled || busy || !text.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 text-zinc-50 rounded text-sm disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          {busy ? "送信中…" : "この内容で改稿する"}
        </button>
      </div>
    </div>
  );
}
