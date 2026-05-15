import { notFound } from "next/navigation";
import { ScreenplayWorkspace } from "@/components/screenplay/ScreenplayWorkspace";
import type { ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";

export const dynamic = "force-dynamic";

async function fetchDetail(id: string) {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const res = await fetch(`${base}/api/screenplays/${id}`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
}

export default async function ScreenplayDetailPage({ params }: { params: Promise<{ id: string; locale: string }> }) {
  const { id } = await params;
  const data = await fetchDetail(id);
  if (!data) notFound();
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-6">
        <div className="text-xs text-zinc-500 mb-1">テレビショッピング台本</div>
        <h1 className="text-2xl font-black">{data.screenplay.title}</h1>
      </header>
      <ScreenplayWorkspace initialScreenplay={data.screenplay} initialVersions={data.versions} />
    </main>
  );
}
