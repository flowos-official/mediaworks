"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { KPICard } from "./KPICard";
import { WeeklyInsightCard } from "./WeeklyInsightCard";
import { CategorySourcingChart } from "./charts/CategorySourcingChart";
import { DailyFeedbackChart } from "./charts/DailyFeedbackChart";
import { ExplorationTrendChart } from "./charts/ExplorationTrendChart";
import { RejectionReasonChart } from "./charts/RejectionReasonChart";

interface InsightsData {
	kpi: {
		thisWeekSourced: number;
		thisWeekRejected: number;
		explorationRatio: number;
		totalSamples: number;
	};
	weeklyInsights: Array<{
		week_start: string;
		context: "home_shopping" | "live_commerce";
		sourced_product_patterns: string | null;
		exploration_wins: string | null;
		next_week_suggestions: string | null;
		sourced_count: number | null;
		rejected_count: number | null;
	}>;
	categoryWeights: Record<string, number>;
	explorationTrend: Array<{ week: string; home: number; live: number }>;
	rejectionReasons: Array<{ reason: string; count: number }>;
	dailyFeedback: Array<{
		date: string;
		sourced: number;
		interested: number;
		rejected: number;
		duplicate: number;
	}>;
}

type ContextFilter = "all" | "home_shopping" | "live_commerce";

export function StatsDashboard() {
	const t = useTranslations("discovery");
	const [data, setData] = useState<InsightsData | null>(null);
	const [loading, setLoading] = useState(true);
	const [context, setContext] = useState<ContextFilter>("all");

	useEffect(() => {
		setLoading(true);
		const params = new URLSearchParams({ weeks: "12" });
		if (context !== "all") params.set("context", context);
		fetch(`/api/discovery/insights?${params}`)
			.then((r) => r.json())
			.then((d) => {
				setData(d);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, [context]);

	if (loading) return <div className="py-20 text-center text-sm text-muted-foreground">Loading...</div>;
	if (!data) return <div className="py-20 text-center text-sm text-muted-foreground">{t("noData")}</div>;

	const categoryData = Object.entries(data.categoryWeights).map(([category, rate]) => ({
		category,
		sourced: 0,
		shown: 0,
		rate,
	}));

	const latestInsight = data.weeklyInsights[0] ?? null;

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs text-muted-foreground">Context:</span>
				{(["all", "home_shopping", "live_commerce"] as ContextFilter[]).map((c) => (
					<button
						key={c}
						type="button"
						onClick={() => setContext(c)}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							context === c
								? "bg-blue-500 text-white border-blue-500"
								: "bg-card text-foreground border-border hover:bg-muted"
						}`}
					>
						{c === "all" ? t("allStatuses") : c === "home_shopping" ? "ホーム" : "ライブ"}
					</button>
				))}
			</div>
			<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
				<KPICard
					label={t("kpiSourcedThisWeek")}
					value={data.kpi.thisWeekSourced}
					subtitle={t("thisWeek")}
					accent="green"
				/>
				<KPICard
					label={t("kpiRejectedThisWeek")}
					value={data.kpi.thisWeekRejected}
					subtitle={t("thisWeek")}
					accent="red"
				/>
				<KPICard
					label={t("kpiExplorationRatio")}
					value={`${Math.round(data.kpi.explorationRatio * 100)}%`}
					accent="blue"
				/>
				<KPICard
					label={t("kpiTotalSamples")}
					value={data.kpi.totalSamples}
					subtitle={t("cumulative")}
					accent="gray"
				/>
			</div>

			<WeeklyInsightCard insight={latestInsight} />

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				<ChartCard title={t("chartCategorySourcing")}>
					<CategorySourcingChart data={categoryData} />
				</ChartCard>
				<ChartCard title={t("chartDailyFeedback")}>
					<DailyFeedbackChart data={data.dailyFeedback} />
				</ChartCard>
				<ChartCard title={t("chartExplorationTrend")}>
					<ExplorationTrendChart data={data.explorationTrend} />
				</ChartCard>
				<ChartCard title={t("chartRejectionReasons")}>
					<RejectionReasonChart data={data.rejectionReasons} />
				</ChartCard>
			</div>
		</div>
	);
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="bg-card border border-border rounded-lg p-4">
			<h4 className="text-sm font-semibold text-foreground mb-3">{title}</h4>
			{children}
		</div>
	);
}
