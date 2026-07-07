import Link from "next/link";
import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ScreenplayList, type Row } from "@/components/screenplay/ScreenplayList";
import { localePath } from "@/lib/i18n/locale-path";
import { getServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Direct Supabase query — avoids the round-trip through /api/screenplays
// which (a) hits NEXT_PUBLIC_SITE_URL (set to prod in env) instead of
// localhost in dev, and (b) cannot forward the user's auth cookies from
// a server component fetch. RLS on `screenplays` (Group B) enforces
// the same member/admin gate as requireUser() in the API route.
async function fetchList(): Promise<Row[]> {
	const sb = await getServerClient();
	// FK must be disambiguated (`!screenplay_id`): screenplays↔screenplay_versions
	// have two foreign keys, so bare `screenplay_versions(count)` throws a
	// PostgREST "more than one relationship" error and blanks the whole list.
	// The count comes back as an array `[{ count: N }]`.
	const { data, error } = await sb
		.from("screenplays")
		.select(
			"id, title, status, updated_at, source_kind, product_id, product_info_snapshot, screenplay_versions!screenplay_id(count)",
		)
		.order("updated_at", { ascending: false })
		.limit(50);
	if (error) {
		console.warn("[screenplays/page] list fetch failed:", error.message);
		return [];
	}
	return (data ?? []).map((r) => {
		const snap = (r.product_info_snapshot ?? {}) as { category?: string };
		const vc = Array.isArray(r.screenplay_versions) ? r.screenplay_versions[0]?.count ?? 0 : 0;
		return {
			id: r.id as string,
			title: r.title as string,
			status: r.status as Row["status"],
			updated_at: r.updated_at as string,
			sourceKind: (r.source_kind ?? null) as Row["sourceKind"],
			category: typeof snap.category === "string" && snap.category.trim() ? snap.category.trim() : null,
			hasProduct: Boolean(r.product_id),
			versionCount: vc as number,
		};
	});
}

export default async function ScreenplaysPage({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	const [rows, t] = await Promise.all([fetchList(), getTranslations("screenplay.list")]);
	return (
		<>
			<header className="flex items-start justify-between gap-4">
				<div>
					<h2 className="text-xl font-semibold text-foreground">{t("title")}</h2>
					<p className="text-sm text-muted-foreground mt-1 max-w-xl">{t("subtitle")}</p>
				</div>
				<Link
					href={localePath(locale, "/screenplays/new")}
					className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors shrink-0"
				>
					<Plus size={16} />
					{t("new")}
				</Link>
			</header>
			<ScreenplayList rows={rows} locale={locale} />
		</>
	);
}
