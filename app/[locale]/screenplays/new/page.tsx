import { ScreenplayCreateForm } from "@/components/screenplay/ScreenplayCreateForm";

export default async function NewScreenplayPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-black mb-2">新しい台本</h1>
      <p className="text-sm text-zinc-500 mb-6">商品情報を入力してください。生成完了まで2〜5分かかります。</p>
      <ScreenplayCreateForm locale={locale} />
    </main>
  );
}
