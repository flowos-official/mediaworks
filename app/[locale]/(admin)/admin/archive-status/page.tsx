import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";
import RetryButton from "./RetryButton";

export const dynamic = "force-dynamic";

interface PageProps {
	params: Promise<{ locale: string }>;
}

export default async function ArchiveStatusPage({ params }: PageProps) {
	const { locale } = await params;
	const auth = await requireUser(["admin"]);
	if ("error" in auth) redirect(localePath(locale, "/login"));
	const sb = auth.sb;

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

	return (
		<div className="max-w-5xl mx-auto p-6">
			<h1 className="text-2xl font-semibold mb-4">Archive Pipeline Status</h1>
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
				{[...counts.entries()].map(([k, v]) => (
					<div key={k} className="border rounded p-3">
						<div className="text-xs text-muted-foreground">{k}</div>
						<div className="text-2xl font-semibold">{v.toLocaleString("ja-JP")}</div>
					</div>
				))}
				<div className="border rounded p-3 bg-muted">
					<div className="text-xs text-muted-foreground">Total archived bytes</div>
					<div className="text-lg font-semibold">{(totalBytes / 1e9).toFixed(2)} GB</div>
					<div className="text-xs text-muted-foreground">≈ ${r2CostUsd} / month</div>
				</div>
			</div>
			<h2 className="text-lg font-semibold mb-2">Recent failures</h2>
			<table className="w-full text-sm">
				<thead className="bg-muted border-b">
					<tr>
						<th className="text-left px-3 py-2">Date</th>
						<th className="text-left px-3 py-2">Channel</th>
						<th className="text-left px-3 py-2">Status</th>
						<th className="text-left px-3 py-2">Attempts</th>
						<th className="text-left px-3 py-2">Error</th>
						<th className="text-left px-3 py-2"></th>
					</tr>
				</thead>
				<tbody>
					{(failures ?? []).map((f: { id: string; channel: string; air_date: string; start_time: string; video_status: string; video_download_attempts: number | null; video_error: string | null }) => (
						<tr key={f.id} className="border-b">
							<td className="px-3 py-2">{f.air_date} {f.start_time}</td>
							<td className="px-3 py-2">{f.channel}</td>
							<td className="px-3 py-2">{f.video_status}</td>
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
