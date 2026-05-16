"use client";

import { useTranslations } from "next-intl";
import type {
	ChannelBaseline,
	PerChannelRunEntry,
} from "@/lib/historical-crawl/runs";

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
	if (r < 0.5) return "bg-red-100 text-red-700";
	if (r < 0.8) return "bg-amber-100 text-amber-700";
	return "bg-green-100 text-green-700";
}

function statusBadgeClass(status: RunRow["status"]): string {
	if (status === "completed") return "bg-green-100 text-green-700";
	if (status === "partial") return "bg-amber-100 text-amber-700";
	if (status === "failed") return "bg-red-100 text-red-700";
	return "bg-gray-100 text-gray-700";
}

export default function HistoricalCrawlDashboard({ initialRuns, baseline }: Props) {
	const t = useTranslations("admin.historicalCrawl");
	const baselineMap = new Map(baseline.map((b) => [b.channel, b.median7d]));

	return (
		<div className="space-y-6">
			<header>
				<h1 className="text-2xl font-bold text-gray-900">{t("title")}</h1>
				<p className="text-sm text-gray-500">{t("subtitle")}</p>
			</header>

			<section>
				<h2 className="text-lg font-semibold text-gray-800 mb-2">
					{t("baselineHeading")}
				</h2>
				{baseline.length === 0 ? (
					<p className="text-sm text-gray-400">{t("baselineEmpty")}</p>
				) : (
					<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
						{baseline
							.slice()
							.sort((a, b) => a.channel.localeCompare(b.channel))
							.map((b) => (
								<div
									key={b.channel}
									className="bg-white border border-gray-200 rounded-lg p-3"
								>
									<div className="text-xs text-gray-500">{b.channel}</div>
									<div className="text-xl font-bold text-gray-900">
										{b.median7d}
									</div>
									<div className="text-[10px] text-gray-400">
										{t("samples", { n: b.samples })}
									</div>
								</div>
							))}
					</div>
				)}
			</section>

			<section>
				<h2 className="text-lg font-semibold text-gray-800 mb-2">
					{t("recentRuns")}
				</h2>
				{initialRuns.length === 0 ? (
					<p className="text-sm text-gray-400">{t("runsEmpty")}</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
							<thead className="bg-gray-50 text-xs uppercase text-gray-500">
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
										className="border-t border-gray-100 hover:bg-gray-50/50"
									>
										<td className="px-3 py-2 text-xs text-gray-700 font-mono whitespace-nowrap">
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
																	? "bg-red-100 text-red-700"
																	: anomalyClass(ratioVal)
															}`}
															title={
																c.error ??
																`${c.rowCount} rows vs median ${median}`
															}
														>
															{c.channel}:{c.rowCount}
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
