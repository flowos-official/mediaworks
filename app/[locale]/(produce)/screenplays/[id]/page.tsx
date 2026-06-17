import Link from "next/link";
import { ChevronLeft, Clapperboard } from "lucide-react";
import { notFound } from "next/navigation";
import { ScreenplayWorkspace } from "@/components/screenplay/ScreenplayWorkspace";
import type { ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";
import type { ScriptCheckResult } from "@/lib/screenplay/compliance/types";
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

	let latestCheck: (ScriptCheckResult & { created_at?: string; lexicon_version?: string }) | null = null;
	if (screenplay.current_version_id) {
		const { data } = await sb
			.from("screenplay_version_checks")
			.select("overall_score, result, created_at, lexicon_version")
			.eq("version_id", screenplay.current_version_id)
			.order("created_at", { ascending: false })
			.limit(1)
			.maybeSingle();
		if (data) latestCheck = { ...(data.result as object), created_at: data.created_at, lexicon_version: data.lexicon_version ?? undefined } as ScriptCheckResult & { created_at?: string; lexicon_version?: string };
	}

	return {
		screenplay: screenplay as ScreenplayRow,
		versions: (versions ?? []) as ScreenplayVersionRow[],
		latestCheck,
	};
}

const STATUS_BADGE: Record<ScreenplayRow["status"], { cls: string; label: string }> = {
	pending: { cls: "bg-yellow-600/15 text-yellow-700 dark:text-yellow-300", label: "待機中" },
	generating: { cls: "bg-blue-600/15 text-blue-700 dark:text-blue-300", label: "生成中" },
	ready: { cls: "bg-green-600/15 text-green-700 dark:text-green-300", label: "完成" },
	failed: { cls: "bg-red-600/15 text-red-700 dark:text-red-300", label: "失敗" },
};

export default async function ScreenplayDetailPage({ params }: { params: Promise<{ id: string; locale: string }> }) {
	const { id, locale } = await params;
	const data = await fetchDetail(id);
	if (!data) notFound();
	const { screenplay, versions, latestCheck } = data;
	const badge = STATUS_BADGE[screenplay.status];

	return (
		<>
			<Link
				href={localePath(locale, "/screenplays")}
				className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-5"
			>
				<ChevronLeft size={14} />
				台本一覧に戻る
			</Link>

			<header className="flex items-start justify-between gap-4 mb-6">
				<div className="min-w-0 flex-1">
					<div className="inline-flex items-center gap-2 bg-blue-600/10 text-blue-700 dark:text-blue-300 text-xs font-medium px-2.5 py-1 rounded-full mb-3">
						<Clapperboard size={12} />
						テレビショッピング台本
					</div>
					<div className="flex items-center gap-3 flex-wrap">
						<h1 className="text-2xl font-bold text-foreground">{screenplay.title}</h1>
						<span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${badge.cls}`}>
							{badge.label}
						</span>
						<span className="text-xs text-muted-foreground">改稿 {versions.length} 回</span>
					</div>
				</div>
			</header>

			<ScreenplayWorkspace
				initialScreenplay={screenplay}
				initialVersions={versions}
				latestCheck={latestCheck}
				initialCheckVersionId={screenplay.current_version_id ?? null}
			/>
		</>
	);
}
