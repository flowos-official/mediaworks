import Link from "next/link";
import { Plus } from "lucide-react";
import { ScreenplayList } from "@/components/screenplay/ScreenplayList";
import { localePath } from "@/lib/i18n/locale-path";
import { getServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Direct Supabase query — avoids the round-trip through /api/screenplays
// which (a) hits NEXT_PUBLIC_SITE_URL (set to prod in env) instead of
// localhost in dev, and (b) cannot forward the user's auth cookies from
// a server component fetch. RLS on `screenplays` (Group B) enforces
// the same member/admin gate as requireUser() in the API route.
async function fetchList() {
	const sb = await getServerClient();
	const { data, error } = await sb
		.from("screenplays")
		.select("id, title, status, updated_at")
		.order("updated_at", { ascending: false })
		.limit(50);
	if (error) {
		console.warn("[screenplays/page] list fetch failed:", error.message);
		return [];
	}
	return (data ?? []) as { id: string; title: string; status: "pending" | "generating" | "ready" | "failed"; updated_at: string }[];
}

export default async function ScreenplaysPage({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	const rows = await fetchList();
	return (
		<>
			<header className="flex items-start justify-between gap-4">
				<div>
					<h2 className="text-xl font-semibold text-foreground">台本一覧</h2>
					<p className="text-sm text-muted-foreground mt-1 max-w-xl">
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
