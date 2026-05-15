import Link from "next/link";
import { ChevronLeft } from "lucide-react";
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

const STATUS_LABEL: Record<ScreenplayRow["status"], string> = {
  pending: "WAIT",
  generating: "ROLL",
  ready: "TAKE",
  failed: "NG",
};

export default async function ScreenplayDetailPage({ params }: { params: Promise<{ id: string; locale: string }> }) {
  const { id, locale } = await params;
  const data = await fetchDetail(id);
  if (!data) notFound();
  const { screenplay, versions } = data;
  const idShort = screenplay.id.slice(0, 8).toUpperCase();
  return (
    <main className="min-h-screen bg-stone-50 [font-family:var(--font-jp)]">
      <div className="mx-auto max-w-[1440px] px-8 py-10">
        <Link
          href={`/${locale}/screenplays`}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 hover:text-stone-900 transition-colors mb-10"
        >
          <ChevronLeft className="h-3 w-3" strokeWidth={2} />
          Registry
        </Link>

        <header className="grid grid-cols-1 lg:grid-cols-[1fr_auto] items-end gap-6 border-b-4 border-double border-stone-900 pb-8 mb-12">
          <div className="min-w-0">
            <div className="flex items-center gap-3 font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 mb-3">
              <span>SP-{idShort}</span>
              <span className="text-stone-300">/</span>
              <span>{STATUS_LABEL[screenplay.status]}</span>
              <span className="text-stone-300">/</span>
              <span className="tabular-nums">{versions.length.toString().padStart(2, "0")} rev</span>
            </div>
            <h1 className="text-[40px] leading-[1.05] font-black tracking-tight text-stone-900">
              {screenplay.title}
            </h1>
          </div>
          <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 text-right leading-relaxed self-end">
            Production · テレ東スタイル<br />
            Gemini 3 Flash · Thinking Low
          </div>
        </header>

        <ScreenplayWorkspace initialScreenplay={screenplay} initialVersions={versions} />
      </div>
    </main>
  );
}
