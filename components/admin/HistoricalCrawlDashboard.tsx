"use client";

import { useTranslations } from "next-intl";
import type {
	ChannelBaseline,
	PerChannelRunEntry,
} from "@/lib/historical-crawl/runs";
import { channelDisplayName } from "@/lib/broadcasts/channel-style";

interface RunRow {
	id: string;
	run_at: string;
	completed_at: string | null;
	jst_date: string;
	status: "running" | "completed" | "partial" | "failed";
	total_rows: number;
	upserted: number;
	skipped_dup: number;
	channels: PerChannelRunEntry[];
	duration_ms: number | null;
	error: string | null;
}

interface Props {
	initialRuns: RunRow[];
	baseline: ChannelBaseline[];
}

function ratio(actual: number, median: number): number {
	if (median <= 0) return 1;
	return actual / median;
}

function anomalyClass(r: number): string {
	if (r < 0.5) return "bg-red-600/15 text-red-700 dark:text-red-300";
	if (r < 0.8) return "bg-amber-600/15 text-amber-700 dark:text-amber-300";
	return "bg-green-600/15 text-green-700 dark:text-green-300";
}

function statusBadgeClass(status: RunRow["status"]): string {
	if (status === "completed") return "bg-green-600/15 text-green-700 dark:text-green-300";
	if (status === "partial") return "bg-amber-600/15 text-amber-700 dark:text-amber-300";
	if (status === "failed") return "bg-red-600/15 text-red-700 dark:text-red-300";
	return "bg-muted text-foreground";
}

export default function HistoricalCrawlDashboard({ initialRuns, baseline }: Props) {
	const t = useTranslations("admin.historicalCrawl");
	const baselineMap = new Map(baseline.map((b) => [b.channel, b.median7d]));

	return (
		<div className="space-y-5">
			<header className="mw-panel px-4 py-4 sm:px-5">
				<div className="mw-kicker mb-1">Ingestion monitor</div>
				<h2 className="text-xl font-bold tracking-[-0.02em] text-foreground">{t("title")}</h2>
				<p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
			</header>

			<section>
				<h2 className="mw-section-title mb-2">
					{t("baselineHeading")}
				</h2>
				{baseline.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("baselineEmpty")}</p>
				) : (
					<div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
						{baseline
							.slice()
							.sort((a, b) => a.channel.localeCompare(b.channel))
							.map((b) => (
								<div
									key={b.channel}
									className="mw-panel p-3"
								>
									<div className="text-xs font-medium text-foreground truncate" title={b.channel}>
										{channelDisplayName(b.channel)}
									</div>
									<div className="mw-data-value mt-1">
										{b.median7d}
									</div>
									<div className="text-[10px] text-muted-foreground font-mono">
										{b.channel} · {t("samples", { n: b.samples })}
									</div>
								</div>
							))}
					</div>
				)}
			</section>

			<section>
				<h2 className="mw-section-title mb-2">
					{t("recentRuns")}
				</h2>
				{initialRuns.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("runsEmpty")}</p>
				) : (
					<div className="mw-table-shell overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="bg-muted text-xs uppercase text-muted-foreground">
								<tr>
									<th className="text-left px-3 py-2">{t("col.runAt")}</th>
									<th className="text-left px-3 py-2">{t("col.status")}</th>
									<th className="text-right px-3 py-2">{t("col.totalRows")}</th>
									<th className="text-right px-3 py-2">{t("col.upserted")}</th>
									<th className="text-right px-3 py-2">{t("col.duration")}</th>
									<th className="text-left px-3 py-2">{t("col.channels")}</th>
								</tr>
							</thead>
							<tbody>
								{initialRuns.map((r) => (
									<tr
										key={r.id}
										className="border-t border-border hover:bg-muted/50"
									>
										<td className="px-3 py-2 text-xs text-foreground font-mono whitespace-nowrap">
											{new Date(r.run_at)
												.toISOString()
												.slice(0, 16)
												.replace("T", " ")}
										</td>
										<td className="px-3 py-2">
											<span
												className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${statusBadgeClass(r.status)}`}
											>
												{r.status}
											</span>
										</td>
										<td className="px-3 py-2 text-right font-mono text-xs">
											{r.total_rows}
										</td>
										<td className="px-3 py-2 text-right font-mono text-xs">
											{r.upserted}
										</td>
										<td className="px-3 py-2 text-right font-mono text-xs">
											{r.duration_ms != null
												? `${(r.duration_ms / 1000).toFixed(1)}s`
												: "-"}
										</td>
										<td className="px-3 py-2">
											<div className="flex flex-wrap gap-1">
												{r.channels.map((c) => {
													const median = baselineMap.get(c.channel) ?? 0;
													const ratioVal = ratio(c.rowCount, median);
													return (
														<span
															key={c.channel}
															className={`text-[10px] px-1.5 py-0.5 rounded ${
																!c.ok
																	? "bg-red-600/15 text-red-700 dark:text-red-300"
																	: anomalyClass(ratioVal)
															}`}
															title={
																c.error ??
																`${c.channel}: ${c.rowCount} rows vs median ${median}`
															}
														>
															{channelDisplayName(c.channel)}:{c.rowCount}
														</span>
													);
												})}
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}
