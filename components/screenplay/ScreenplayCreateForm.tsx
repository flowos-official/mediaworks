"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight } from "lucide-react";

interface FieldProps {
  label: string;
  serial: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, serial, required, hint, children }: FieldProps) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-6 border-b border-stone-200 py-6">
      <div>
        <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500">{serial}</div>
        <div className="mt-2 text-sm font-bold text-stone-900 leading-snug">
          {label}
          {required && <span className="text-stone-400 ml-1">*</span>}
        </div>
        {hint && <div className="mt-1 text-[11px] text-stone-500 leading-relaxed">{hint}</div>}
      </div>
      <div className="self-start">{children}</div>
    </div>
  );
}

const inputBase =
  "w-full bg-transparent border-0 border-b border-stone-300 px-0 py-2 text-[15px] text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900 transition-colors";

export function ScreenplayCreateForm({ locale }: { locale: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [list, setList] = useState("");
  const [sale, setSale] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = {
        productBrief: {
          name: name.trim(),
          category: category.trim() || undefined,
          description: description.trim(),
          price: {
            listJpy: list ? Number(list) : undefined,
            saleJpy: sale ? Number(sale) : undefined,
          },
        },
      };
      const res = await fetch(`/api/screenplays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "create failed");
      router.push(`/${locale}/screenplays/${j.id}?run=${j.runId}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
      setBusy(false);
    }
  }

  const charCount = description.length;

  return (
    <form onSubmit={submit} className="[font-family:var(--font-jp)]">
      <div className="border-t border-stone-900">
        <Field
          serial="F-01"
          label="商品名"
          required
          hint="台本のタイトルにそのまま使用されます。"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="例: アイアジャストグラス"
            className={inputBase}
          />
        </Field>

        <Field serial="F-02" label="カテゴリ" hint="任意。ジャンルを指定すると話法が最適化されます。">
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="例: ヘルスケア・日用品"
            className={inputBase}
          />
        </Field>

        <Field
          serial="F-03"
          label="特徴・スペック"
          required
          hint="自由に貼り付け可。JANコードや梱包情報など放送不要な情報は除外されます。"
        >
          <div className="relative">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={12}
              placeholder="商品の特徴、対象ユーザー、素材、技術的なポイントなど自由に貼り付けてください。"
              className={`${inputBase} resize-none leading-[1.85]`}
            />
            <div className="mt-2 font-mono text-[10px] tracking-widest uppercase text-stone-400 tabular-nums">
              {charCount.toLocaleString().padStart(5, "0")} chars
            </div>
          </div>
        </Field>

        <Field serial="F-04" label="メーカー直販価格 (¥)" hint="任意。バリュースタックのアンカー価格として使用。">
          <input
            type="number"
            value={list}
            onChange={(e) => setList(e.target.value)}
            placeholder="14800"
            className={`${inputBase} font-mono tabular-nums`}
          />
        </Field>

        <Field serial="F-05" label="本日特別価格 (¥)" hint="任意。落としの最終価格として使用。">
          <input
            type="number"
            value={sale}
            onChange={(e) => setSale(e.target.value)}
            placeholder="9800"
            className={`${inputBase} font-mono tabular-nums`}
          />
        </Field>
      </div>

      {err && (
        <div className="mt-6 border border-stone-900 bg-stone-50 px-4 py-3 font-mono text-[11px] tracking-wide text-stone-900">
          NG / {err}
        </div>
      )}

      <div className="mt-12 flex items-center justify-between gap-6">
        <div className="font-mono text-[11px] tracking-[0.25em] uppercase text-stone-500 leading-relaxed">
          ETA <span className="text-stone-900">2 — 5 min</span><br />
          Gemini 3 Flash · Thinking LOW
        </div>
        <button
          disabled={busy || !name.trim() || !description.trim()}
          className="group relative inline-flex items-center gap-4 bg-stone-900 text-stone-50 pl-7 pr-5 py-4 hover:bg-stone-800 disabled:bg-stone-300 disabled:cursor-not-allowed transition-colors"
        >
          <span className="font-mono text-[11px] tracking-[0.35em] uppercase">
            {busy ? "Rolling…" : "Roll Camera"}
          </span>
          <ArrowRight
            className={`h-4 w-4 transition-transform ${busy ? "" : "group-hover:translate-x-1"}`}
            strokeWidth={2}
          />
        </button>
      </div>
    </form>
  );
}
