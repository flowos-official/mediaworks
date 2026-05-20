import Link from "next/link";
import { ChevronLeft, Clapperboard } from "lucide-react";
import { notFound } from "next/navigation";
import { ScreenplayWorkspace } from "@/components/screenplay/ScreenplayWorkspace";
import type { ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";
import { localePath } from "@/lib/i18n/locale-path";
import { getServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Direct Supabase query — same rationale as screenplays/page.tsx:
// the previous fetch to /api/screenplays/[id] hit the prod URL in dev and
// could not forward auth cookies from a server component.
async function fetchDetail(id: string) {
	if (!UUID_RE.test(id)) return null;
	const sb = await getServerClient();

	const { data: screenplay, error: spErr } = await sb
		.from("screenplays")
		.select("*")
		.eq("id", id)
		.maybeSingle();
	if (spErr || !screenplay) return null;

	const { data: versions } = await sb
		.from("screenplay_versions")
		.select(
			"id, version_number, markdown, feedback, base_version_id, model, thinking_level, created_at",
		)
		.eq("screenplay_id", id)
		.order("version_number", { ascending: true });

	return {
		screenplay: screenplay as ScreenplayRow,
		versions: (versions ?? []) as ScreenplayVersionRow[],
	};
}

const STATUS_BADGE: Record<ScreenplayRow["status"], { cls: string; label: string }> = {
	pending: { cls: "bg-yellow-100 text-yellow-700", label: "待機中" },
	generating: { cls: "bg-blue-100 text-blue-700", label: "生成中" },
	ready: { cls: "bg-green-100 text-green-700", label: "完成" },
	failed: { cls: "bg-red-100 text-red-700", label: "失敗" },
};

export default async function ScreenplayDetailPage({ params }: { params: Promise<{ id: string; locale: string }> }) {
	const { id, locale } = await params;
	const data = await fetchDetail(id);
	if (!data) notFound();
	const { screenplay, versions } = data;
	const badge = STATUS_BADGE[screenplay.status];

	return (
		<>
			<Link
				href={localePath(locale, "/screenplays")}
				className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-5"
			>
				<ChevronLeft size={14} />
				台本一覧に戻る
			</Link>

			<header className="flex items-start justify-between gap-4 mb-6">
				<div className="min-w-0 flex-1">
					<div className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 text-xs font-medium px-2.5 py-1 rounded-full mb-3">
						<Clapperboard size={12} />
						テレビショッピング台本
					</div>
					<div className="flex items-center gap-3 flex-wrap">
						<h1 className="text-2xl font-bold text-gray-900">{screenplay.title}</h1>
						<span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${badge.cls}`}>
							{badge.label}
						</span>
						<span className="text-xs text-gray-400">改稿 {versions.length} 回</span>
					</div>
				</div>
			</header>

			<ScreenplayWorkspace initialScreenplay={screenplay} initialVersions={versions} />
		</>
	);
}
