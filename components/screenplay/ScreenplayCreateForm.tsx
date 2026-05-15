"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Sparkles } from "lucide-react";

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

  return (
    <form onSubmit={submit} className="space-y-4 max-w-2xl">
      <div>
        <label className="text-sm font-bold block mb-1">商品名 *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" />
      </div>
      <div>
        <label className="text-sm font-bold block mb-1">カテゴリ</label>
        <input value={category} onChange={(e) => setCategory(e.target.value)} className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" placeholder="例: ヘルスケア・日用品" />
      </div>
      <div>
        <label className="text-sm font-bold block mb-1">特徴・スペック *</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} required rows={10} className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" placeholder="商品の特徴、対象ユーザー、素材、技術的なポイントなど自由に貼り付けてください。" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-bold block mb-1">メーカー直販価格 (¥)</label>
          <input type="number" value={list} onChange={(e) => setList(e.target.value)} className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-sm font-bold block mb-1">本日特別価格 (¥)</label>
          <input type="number" value={sale} onChange={(e) => setSale(e.target.value)} className="w-full border border-zinc-300 rounded px-3 py-2 text-sm" />
        </div>
      </div>
      {err && <div className="text-xs text-zinc-700">{err}</div>}
      <div className="flex justify-end">
        <button disabled={busy || !name.trim() || !description.trim()} className="inline-flex items-center gap-2 bg-zinc-900 text-zinc-50 px-4 py-2 rounded text-sm disabled:opacity-50">
          <Sparkles className="h-4 w-4" /> {busy ? "送信中…" : "台本を生成する"}
        </button>
      </div>
    </form>
  );
}
