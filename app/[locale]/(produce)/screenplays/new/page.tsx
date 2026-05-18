import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ScreenplayCreateForm } from "@/components/screenplay/ScreenplayCreateForm";
import { localePath } from "@/lib/i18n/locale-path";

export default async function NewScreenplayPage({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	return (
		<main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
			<Link
				href={localePath(locale, "/screenplays")}
				className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-6"
			>
				<ChevronLeft size={14} />
				台本一覧に戻る
			</Link>

			<header className="mb-8">
				<h1 className="text-3xl font-bold text-gray-900">新しい台本を作成</h1>
				<p className="text-sm text-gray-500 mt-2 max-w-2xl">
					登録済みの商品から選ぶか、商品情報を直接入力すると、テレビ東京系「生活情報マーケット」スタイルの完成版台本を起こします。アバン → スタジオ① 〜 ④ → CTA → VTR お客様の声 → CTA の構成で出力されます。
				</p>
			</header>

			<ScreenplayCreateForm locale={locale} />
		</main>
	);
}
