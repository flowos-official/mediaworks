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
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black">テレビショッピング 台本</h1>
          <p className="text-sm text-zinc-500 mt-1">商品ごとに、生放送さながらの台本を生成・改稿できます。</p>
        </div>
        <Link href={`/${locale}/screenplays/new`} className="inline-flex items-center gap-2 bg-zinc-900 text-zinc-50 px-4 py-2 rounded text-sm">
          <Plus className="h-4 w-4" /> 新規作成
        </Link>
      </header>
      <ScreenplayList rows={rows} locale={locale} />
    </main>
  );
}
