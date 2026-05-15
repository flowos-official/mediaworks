import Link from "next/link";
import { Plus, Clapperboard } from "lucide-react";
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
		<main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
			<header className="flex items-start justify-between gap-4 mb-8">
				<div>
					<div className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 text-sm font-medium px-3 py-1.5 rounded-full mb-3">
						<Clapperboard size={14} />
						テレビショッピング 台本ジェネレーター
					</div>
					<h1 className="text-3xl font-bold text-gray-900">台本一覧</h1>
					<p className="text-sm text-gray-500 mt-2 max-w-xl">
						商品を選んで、生放送さながらのテレビショッピング台本を作成します。フィードバックを送ると何度でも改稿できます。
					</p>
				</div>
				<Link
					href={`/${locale}/screenplays/new`}
					className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors shrink-0"
				>
					<Plus size={16} />
					新しい台本を作成
				</Link>
			</header>
			<ScreenplayList rows={rows} locale={locale} />
		</main>
	);
}
