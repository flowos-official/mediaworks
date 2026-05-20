import Link from "next/link";
import { ChevronLeft, Clapperboard } from "lucide-react";
import { ScreenplayCreateForm } from "@/components/screenplay/ScreenplayCreateForm";
import { localePath } from "@/lib/i18n/locale-path";

export default async function NewScreenplayPage({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	return (
		<main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
			<Link
				href={localePath(locale, "/screenplays")}
				className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900 transition-colors mb-8"
			>
				<ChevronLeft size={14} />
				台本一覧に戻る
			</Link>

			<header className="mb-10 relative">
				<div className="flex items-start gap-4">
					<div className="hidden sm:flex w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 items-center justify-center shadow-sm shadow-blue-200/60 ring-1 ring-blue-100">
						<Clapperboard size={20} className="text-white" />
					</div>
					<div className="flex-1 min-w-0">
						<div className="text-[11px] font-semibold tracking-[0.18em] uppercase text-blue-600/80 mb-1">
							Screenplay Studio
						</div>
						<h1 className="text-[2rem] leading-tight font-bold text-gray-900 tracking-tight">
							新しい台本を作成
						</h1>
						<p className="text-sm text-gray-500 mt-2 max-w-2xl leading-relaxed">
							商品資料 (PDF / Excel / 画像) をアップロードするか、商品ページのURLを指定すると、Gemini が内容を読み取り、テレビ東京系「生活情報マーケット」スタイルの完成版台本を起こします。アバン → スタジオ① 〜 ④ → CTA → VTR お客様の声 → CTA の構成で出力されます。
						</p>
					</div>
				</div>
			</header>

			<ScreenplayCreateForm locale={locale} />
		</main>
	);
}
