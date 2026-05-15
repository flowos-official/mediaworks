import Link from "next/link";
import { Plus } from "lucide-react";
import { ScreenplayList } from "@/components/screenplay/ScreenplayList";

export const dynamic = "force-dynamic";

async function fetchList() {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const res = await fetch(`${base}/api/screenplays`, { cache: "no-store" });
  if (!res.ok) return [];
  const j = (await res.json()) as {
    screenplays: { id: string; title: string; status: "pending" | "generating" | "ready" | "failed"; updated_at: string }[];
  };
  return j.screenplays;
}

export default async function ScreenplaysPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const rows = await fetchList();
  return (
    <main className="min-h-screen bg-stone-50 [font-family:var(--font-jp)]">
      <div className="mx-auto max-w-6xl px-8 py-14">
        <div className="font-mono text-[10px] tracking-[0.35em] uppercase text-stone-500 mb-3">
          Section 03 · Screenplay Registry
        </div>
        <header className="grid grid-cols-1 lg:grid-cols-[1fr_auto] items-end gap-6 border-b-4 border-double border-stone-900 pb-8 mb-12">
          <div>
            <h1 className="text-[44px] leading-[1.05] font-black tracking-tight text-stone-900">
              テレビショッピング<br />台本ライブラリ
            </h1>
            <p className="mt-4 text-sm text-stone-600 max-w-md leading-relaxed">
              商品ごとに生放送さながらの台本を起こし、フィードバックで何度でも改稿できます。
            </p>
          </div>
          <Link
            href={`/${locale}/screenplays/new`}
            className="group inline-flex items-center gap-3 self-end bg-stone-900 text-stone-50 px-6 py-3.5 hover:bg-stone-800 transition-colors"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
            <span className="font-mono text-[11px] tracking-[0.3em] uppercase">New Take</span>
          </Link>
        </header>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-stone-200 border border-stone-200 mb-12">
          <Stat label="Total" value={rows.length.toString()} />
          <Stat label="Ready" value={rows.filter((r) => r.status === "ready").length.toString()} />
          <Stat label="Rolling" value={rows.filter((r) => r.status === "generating").length.toString()} />
          <Stat label="Pending" value={rows.filter((r) => r.status === "pending").length.toString()} />
        </div>

        <ScreenplayList rows={rows} locale={locale} />
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-stone-50 px-5 py-4">
      <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500">{label}</div>
      <div className="mt-1 font-mono text-3xl font-bold text-stone-900 tabular-nums">{value.padStart(2, "0")}</div>
    </div>
  );
}
