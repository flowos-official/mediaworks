import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ScreenplayCreateForm } from "@/components/screenplay/ScreenplayCreateForm";

export default async function NewScreenplayPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <main className="min-h-screen bg-stone-50 [font-family:var(--font-jp)]">
      <div className="mx-auto max-w-3xl px-8 py-14">
        <Link
          href={`/${locale}/screenplays`}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 hover:text-stone-900 transition-colors mb-12"
        >
          <ChevronLeft className="h-3 w-3" strokeWidth={2} />
          Back to Registry
        </Link>

        <div className="font-mono text-[10px] tracking-[0.35em] uppercase text-stone-500 mb-3">
          New Production · Sheet 01
        </div>
        <h1 className="text-[40px] leading-[1.05] font-black tracking-tight text-stone-900 border-b-4 border-double border-stone-900 pb-8 mb-2">
          新規台本<br />ブリーフ
        </h1>
        <p className="text-sm text-stone-600 leading-relaxed mt-6 mb-10 max-w-xl">
          下記の項目を埋めると、Gemini 3.1 Pro が商品情報を解釈し、テレ東スタイルの完成版台本（アバン → スタジオ① 〜 ④ → CTA → VTR → CTA）を起こします。
        </p>

        <ScreenplayCreateForm locale={locale} />
      </div>
    </main>
  );
}
