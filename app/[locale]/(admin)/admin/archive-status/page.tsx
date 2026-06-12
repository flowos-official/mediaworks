import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";
import RetryButton from "./RetryButton";

const VIDEO_STATUS_KEYS = new Set(["queued", "downloading", "archived", "abandoned", "deferred"]);

export const dynamic = "force-dynamic";

interface PageProps {
	params: Promise<{ locale: string }>;
}

export default async function ArchiveStatusPage({ params }: PageProps) {
	const { locale } = await params;
	const auth = await requireUser(["admin"]);
	if ("error" in auth) redirect(localePath(locale, "/login"));
	const sb = auth.sb;
	const t = await getTranslations("admin.archiveStatus");
	const statusLabel = (s: string) => (VIDEO_STATUS_KEYS.has(s) ? t(`videoStatus.${s}`) : s);

	const { data: tally } = await sb
		.from("broadcasts")
		.select("video_status")
		.not("video_status", "is", null);
	const counts = new Map<string, number>();
	for (const r of (tally ?? []) as { video_status: string }[]) {
		counts.set(r.video_status, (counts.get(r.video_status) ?? 0) + 1);
	}

	const { data: failures } = await sb
		.from("broadcasts")
		.select("id, channel, air_date, start_time, video_status, video_download_attempts, video_error")
		.in("video_status", ["abandoned", "deferred"])
		.order("air_date", { ascending: false })
		.limit(50);

	const { data: sizes } = await sb
		.from("broadcasts")
		.select("video_size_bytes")
		.eq("video_status", "archived");
	const totalBytes = (sizes ?? []).reduce(
		(sum, r: { video_size_bytes: number | null }) => sum + (r.video_size_bytes ?? 0),
		0,
	);
	const r2CostUsd = ((totalBytes / 1e9) * 0.015).toFixed(2);

	const { data: latestRun } = await sb
		.from("archive_reconciliation_runs")
		.select("ran_at, coverage_pct, healed, unhealable, no_source, coverage_by_day, gaps")
		.order("ran_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	const run = latestRun as null | {
		ran_at: string; coverage_pct: number; healed: number; unhealable: number; no_source: number;
		coverage_by_day: { channel: string; air_date: string; expected: number; archived: number; coverage: number }[];
		gaps: { channel: string; air_date: string; start_time: string; status: string; classification: string; reason: string }[];
	};
	const redAt = Number(process.env.RECONCILE_COVERAGE_RED ?? 90);
	const amberAt = Number(process.env.RECONCILE_COVERAGE_AMBER ?? 98);
	const gateColor = (c: number) => (c < redAt ? "#dc2626" : c < amberAt ? "#d97706" : "#16a34a");

	return (
		<div className="max-w-5xl mx-auto p-6">
			<h1 className="text-2xl font-semibold mb-4">{t("title")}</h1>
			{run && (
				<section className="mb-8 border rounded p-4">
					<h2 className="text-lg font-semibold mb-2">
						{t("reconciliation.heading")} <span className="text-xs text-muted-foreground">({new Date(run.ran_at).toLocaleString("ja-JP")})</span>
					</h2>
					<div className="flex gap-4 mb-3 text-sm">
						<span>{t("reconciliation.overall")} <b style={{ color: gateColor(run.coverage_pct) }}>{run.coverage_pct}%</b></span>
						<span>{t("reconciliation.healed")} {run.healed}</span>
						<span className={run.unhealable > 0 ? "text-red-600 font-semibold" : ""}>{t("reconciliation.unhealable")} {run.unhealable}</span>
						<span className="text-muted-foreground">{t("reconciliation.noSource")} {run.no_source}</span>
					</div>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-2">
						{(run.coverage_by_day ?? []).map((c) => (
							<div key={`${c.channel}-${c.air_date}`} className="border rounded px-2 py-1 text-xs">
								<div className="text-muted-foreground">{c.channel} {c.air_date}</div>
								<div style={{ color: gateColor(c.coverage) }} className="font-semibold">{c.coverage}% ({c.archived}/{c.expected})</div>
							</div>
						))}
					</div>
					{run.unhealable > 0 && (
						<ul className="mt-3 text-xs text-red-700 list-disc pl-5">
							{(run.gaps ?? []).filter((g) => g.classification === "unhealable").map((g) => (
								<li key={`${g.channel}-${g.air_date}-${g.start_time}`}>[{g.channel}] {g.air_date} {g.start_time} — {g.reason}</li>
							))}
						</ul>
					)}
				</section>
			)}
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
				{[...counts.entries()].map(([k, v]) => (
					<div key={k} className="border rounded p-3">
						<div className="text-xs text-muted-foreground">{statusLabel(k)}</div>
						<div className="text-2xl font-semibold">{v.toLocaleString("ja-JP")}</div>
					</div>
				))}
				<div className="border rounded p-3 bg-muted">
					<div className="text-xs text-muted-foreground">{t("totalArchivedBytes")}</div>
					<div className="text-lg font-semibold">{(totalBytes / 1e9).toFixed(2)} GB</div>
					<div className="text-xs text-muted-foreground">{t("perMonth", { cost: r2CostUsd })}</div>
				</div>
			</div>
			<h2 className="text-lg font-semibold mb-2">{t("recentFailures")}</h2>
			<table className="w-full text-sm">
				<thead className="bg-muted border-b">
					<tr>
						<th className="text-left px-3 py-2">{t("col.date")}</th>
						<th className="text-left px-3 py-2">{t("col.channel")}</th>
						<th className="text-left px-3 py-2">{t("col.status")}</th>
						<th className="text-left px-3 py-2">{t("col.attempts")}</th>
						<th className="text-left px-3 py-2">{t("col.error")}</th>
						<th className="text-left px-3 py-2"></th>
					</tr>
				</thead>
				<tbody>
					{(failures ?? []).map((f: { id: string; channel: string; air_date: string; start_time: string; video_status: string; video_download_attempts: number | null; video_error: string | null }) => (
						<tr key={f.id} className="border-b">
							<td className="px-3 py-2">{f.air_date} {f.start_time}</td>
							<td className="px-3 py-2">{f.channel}</td>
							<td className="px-3 py-2">{statusLabel(f.video_status)}</td>
							<td className="px-3 py-2">{f.video_download_attempts ?? 0}</td>
							<td className="px-3 py-2 text-xs text-muted-foreground">{f.video_error?.slice(0, 80)}</td>
							<td className="px-3 py-2">
								<RetryButton broadcastId={f.id} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
