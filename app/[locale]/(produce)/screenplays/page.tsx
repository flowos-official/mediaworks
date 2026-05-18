import Link from "next/link";
import { Plus } from "lucide-react";
import { ScreenplayList } from "@/components/screenplay/ScreenplayList";
import { localePath } from "@/lib/i18n/locale-path";

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
		<>
			<header className="flex items-start justify-between gap-4">
				<div>
					<h2 className="text-xl font-semibold text-gray-900">台本一覧</h2>
					<p className="text-sm text-gray-500 mt-1 max-w-xl">
						商品を選んで、生放送さながらのテレビショッピング台本を作成します。フィードバックを送ると何度でも改稿できます。
					</p>
				</div>
				<Link
					href={localePath(locale, "/screenplays/new")}
					className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors shrink-0"
				>
					<Plus size={16} />
					新しい台本を作成
				</Link>
			</header>
			<ScreenplayList rows={rows} locale={locale} />
		</>
	);
}
